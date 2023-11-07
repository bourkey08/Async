class ThreadPool {
    /*Array of running workers each entry is a dict in the format 
    {
        'Worker': Worker,
        'LastActive': last active time of worker is ms, 
        'IsIdle': true/false
    }

    */
    #Workers = [];

    //Define a dict of functions, this will be in the format id: functionstring
    #Functions = {};

    #TaskQueue = {
        'Queue': [],//Array of dicts where each entry is in the format {'FunctionID': int, 'JobID': int, 'args': jsonstring}
        'Callbacks': {}//JobID: promise resolv function
    };

    //Counters for allocating unique ids to job and functions
    #JobCounter = 0;
    #FunctionCounter = 0;

    //Private variable for storing config info passed to the class constructor
    #Config;

    constructor(MinWorkers=1, MaxWorkers=null, IdleTimeOut=60, WorkerPath='libs/threadpool.worker.js'){
        this.#Config = {
            'MinWorkers': MinWorkers,
            'MaxWorkers': MaxWorkers === null ? navigator.hardwareConcurrency : MaxWorkers,
            'IdleTimeOut': IdleTimeOut,
            'WorkerPath': WorkerPath
        }

        //Start the minimum number of workers immediatly
        for (let i=0; i<MinWorkers; i++){
            this.#StartWorker();
        }

        //Start worker maitenance function, this cleans up workers that have been idle for more than the idletimeout (keeping at a minimum min workers running)
        this.#MaintainWorkers();
    }

    //Starts a new web worker
    async #StartWorker(){
        const NewWorker = {
            'Worker':  new Worker(this.#Config['WorkerPath']),
            'LastActive': (new Date).getTime(),
            'IsIdle': false//Defualt to false, will be set to true once the worker posts a message indicating that it is ready for use
        };

        //Start a new worker and add it to the worker array
        this.#Workers.push(NewWorker);

        //Called when a message is received from the web worker
        NewWorker['Worker'].onmessage = (msg) => {
            //Set the last activet time of this worker to be now as we have just received a message from it
            NewWorker['LastActive'] = (new Date).getTime();

            switch (msg['data']['Type']){
                case ('Status'):
                    if (msg['data']['Status'] === 'ready'){
                        //Call function to either get the next queued job or mark the worker as idle
                        this.#WorkerBecameIdle(NewWorker);

                    } else{
                        NewWorker['IsIdle'] = false;
                    }
                    break;

                //Worker is requesting a function, this will be in response to a worker being asked to execute a function that it does not yet have
                case ('ReqFunct'):
                    NewWorker['Worker'].postMessage({
                        'Type': 'Function',
                        'ID': msg['data']['ID'],
                        'Function': this.#Functions[msg['data']['ID']]
                    });
                    break;

                //Worker has responded with the result of a job, we need to resolv the promise for the job and mark the worker as idle
                case ('Result'):
                    this.#TaskQueue.Callbacks[msg['data']['ID']](JSON.parse(msg['data']['Result']))
                    
                    //Call function to either get the next queued job or mark the worker as idle
                    this.#WorkerBecameIdle(NewWorker);
                    break;                    

                default:
                    console.log(msg['data']);
                    break;
            }
        };
    }

    //Called when a worker finishes a task or expicitly reports its idle, Fetches the net task in the queue and assigns it to the worker, If the queue is empty marks the worker as idle
    #WorkerBecameIdle(Worker){
        //If there are no pending tasks in the queue, mark the worker as idle
        if (this.#TaskQueue['Queue'].length === 0){
            Worker['IsIdle'] = true;

        //Otherwise get the next entry from the queue and assign it to this worker
        } else {
            //Get the next job from the queue removing it from the queue in the process (This returns an array but this array will always contain 1 element)
            const NextJob = this.#TaskQueue['Queue'].splice(0, 1)[0];

            Worker['Worker'].postMessage({
                'Type': 'Job',
                'funct': NextJob['FunctionID'],
                'args': NextJob['args'],
                'ID': NextJob['JobID']
            });
        }
    }

    //Get returns a worker if there is a free worker, otherwise spawns a new worker if max workers has not yet been reached. Returns null if there are no available workers(or if a worker is spawned as it takes time to start)
    #GetFreeWorker(){
        //Check for idle workers
        for (let i=0; i<this.#Workers.length; i++){
            if (this.#Workers[i]['IsIdle']){
                //Mark the worker as no longer idle
                this.#Workers[i]['IsIdle'] = false;
                this.#Workers[i]['LastActive'] = (new Date).getTime();//And update its last active time
                return this.#Workers[i];
            }
        }

        //If no idle worker was found, check if there are already max workers running
        if (this.#Workers.length < this.#Config['MaxWorkers']){
            this.#StartWorker();
        }

        //And return null indicating that a free worker was not found
        return null;
    }

    //Wrap a function reutrning a class that when run will execute the funtion in a worker returning a promise that resolves to the functions return value
    Wrap(funct){
        //Get the next available funcntion id
        const FunctID = (this.#FunctionCounter++).toString();

        this.#Functions[FunctID] = funct.toString();

        //Define a variable to track if this function has been disposed, if it has all calls to this function need ot raise an exception
        let IsDisposed = false;

        //Define the funcion we will return, When this function is called it will execute the function specified by funct in a worker and then resolv with the results
        const WrappedFunct = (async (...args) => {
            //If ths function has been disposed of, raise and exception as its not able to be called as the code behind the wraped function is no longer available
            if (IsDisposed){
                throw "Attempted to call disposed function";
            }

            //Get a unique ID for this job
            const JobID = (this.#JobCounter++).toString();

            //Create a callback for this job, this will be run by the worker upon completion of the job and passed the functions return value
            const JobPromise = new Promise((resolv, reject) => {
                this.#TaskQueue['Callbacks'][JobID] = resolv;
            })

            //First attempt to get a free worker from the pool
            const AllocatedWorker = this.#GetFreeWorker();

            //If a free worker was returned, submit the job to it immediatly
            if (AllocatedWorker !== null){
                AllocatedWorker['Worker'].postMessage({
                    'Type': 'Job',
                    'funct': FunctID,
                    'args': args,
                    'ID': JobID
                });

            //Otherwise there is no worker available to process the request immediatly, add the request into the queue
            } else {
                //Add the job to the queue
                this.#TaskQueue['Queue'].push({'FunctionID': FunctID, 'JobID': JobID, 'args': args});
            }

            //Now await the callback resolving and return its output
            return await JobPromise;
        }).bind(this);

        //Add a function to the wrapped function to mark the function as disposed, this will remove it from any running web workers as well as the main function store
        WrappedFunct.dispose = () => {
            //Remove the function from the main function cache
            delete this.#Functions[FunctID];

            //Iterate over all web workers and post a function disposed message to each worker
            for (let i=0; i<this.#Workers.length; i++){
                this.#Workers[i].Worker.postMessage({
                    'Type': 'FunctDispose',
                    'ID': FunctID
                });
            }

            //Mark the fuction as disposed, this prevents attempts to call the function after disposing of it incase the reference to the disposed function still exists
            IsDisposed = true;
        }

        //Return the wrapped function
        return WrappedFunct;
    }

    //Immediatly stops all workers and frees memory used by stored functions and any outstanding queued jobs
    Shutdown(){
        this.Wrap = null;
        this.#Functions = null;
        this.#TaskQueue = null;
        this.#Config = null;

        //Terminate all the workerss
        for (let Worker of this.#Workers){
            Worker.Worker.terminate();
        }

        //And delete the workers array
        this.#Workers = null;
    }

    //Runs periodically and cleans up idle workers, spawning of workers is handled when jobs are submitted
    async #MaintainWorkers(){
        //If the config varable has been set to null then the thread pool has been shutdown, return without scheduling this function to run again(aborting the recall loop)
        if (this.#Config === null){
            return 0;
        }

        //Get the idle cuttoff time for workers once so we dont need to calculate this for each iteration of the loop
        const IdleCutoff = (new Date).getTime() - (this.#Config.IdleTimeOut * 1000);

        //Where there are more than the minimum number of workers running, check for a worker we are able to terminate
        while (this.#Workers.length > this.#Config.MinWorkers){
            let WorkerTerminated = false;

            //Iterate over all workers and find the first worker that is both idle and has a last active time older than the cutoff time
            for (let i=0; i<this.#Workers.length; i++){
                if (this.#Workers[i].IsIdle && this.#Workers[i].LastActive < IdleCutoff){

                    //Set worker terminated to true so that we then restart the loop searching for the next worker thats ready to be terminated (if min workers criteria is still meet)
                    WorkerTerminated = true;

                    //Now terminate the worker
                    this.#Workers[i].Worker.terminate();
                    
                    //And finally remove it from the list of running workers
                    this.#Workers.splice(i, 1);

                    break;
                }
            }

            //If there are no workers that have been idle for long enough to stop them, then break out of the loop
            if (!WorkerTerminated){
                break;
            }
        }

        //Run again in 1 second
        setTimeout(()=> {this.#MaintainWorkers()}, 1000);
    }
}

async function PerfTest(){
    var tpool = new ThreadPool();

    const IsPrime = tpool.Wrap((a) => {
        let b = 2

        while (a / 2 > b){
            if (a % b == 0){
                return false;          
            } else {
                b += 1
            }
        }

        return true
    });

    let start;

    start = performance.now();
    await IsPrime(1127177431);
    console.log(performance.now() - start);

    start = performance.now();
    let Jobs = [];

    for (let i=0; i<16; i++){
        Jobs.push(IsPrime(1127177431));
    }

    await Promise.all(Jobs);
    console.log(performance.now() - start);

    //Now shutdown the thread pool
    tpool.Shutdown();
}