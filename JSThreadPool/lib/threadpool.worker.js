//Dict to store a list of functions that are currently available in this web worker
CachedFunctions = {};

//Dict to store promise to be resolved after a function has been retreived
//When a function is required that is not already loaded a promise will be added to this dict prior to submitting the load request
//Once the main thread responds with the requested fucntion the promise will resolve allowing the execution of the job to resume
FunctionLoadingPromises = {};

WorkerID = null;//Will be set to the ID of the worker once the worker is provided its id by the main thread

//Make a request to the main thread for a function that we do not yet have cached locally
async function GetFunction(functid){
    //If the target function is already in the cache return it immediatly
    if (typeof(CachedFunctions[functid]) !== 'undefined'){
        return CachedFunctions[functid];

    } else {
        const LoadFunctPromise = new Promise((resolv, reject) => {
            FunctionLoadingPromises[functid] = resolv;
        });

        this.postMessage({
            'Type': 'ReqFunct',
            'ID': functid
        });

        //Now wait for the fuction to be loaded
        await LoadFunctPromise;

        //And return the function
        return CachedFunctions[functid];
    }    
}


//Handle incomming messages from the main thread
this.onmessage = async (msg) => {
    switch (msg['data']['Type']){
        //New Job Received
        case ('Job'):
            //Get the function we need to execute
            const Funct = await GetFunction(msg['data']['funct']);

            //Now call the function with the specified arguments and return the result
            const Result = await Funct(...msg['data']['args']);

            //Now post the result back to the main thread
            this.postMessage(JSON.stringify({
                'Type': 'Result',
                'ID': msg['data']['ID'],
                'Result': Result
            }));
            break;

        //The main thread has responded to our request for a function
        case ('Function'):
            //Evaluate the function string assigning it to cached functions under the correct function id
            await eval(`CachedFunctions['${msg['data']['ID']}'] = ${msg['data']['Function']}`);

            //If there is a promise for this function in functionloadingpromises resolv it now
            if (typeof(FunctionLoadingPromises[msg['data']['ID']]) !== 'undefined'){
                //Call the resolv function passing true as the argument
                FunctionLoadingPromises[msg['data']['ID']](true);

                //And remove the entry from function loading promises
                delete FunctionLoadingPromises[msg['data']['ID']];
            }

            break;

        case ('FunctDispose'):
            if (typeof(CachedFunctions[msg['data']['ID']]) !== 'undefined'){
                delete CachedFunctions[msg['data']['ID']];
            }
            break;

        default:
            console.log(msg['data']);
            break;
    }
}

//Let the main thread know that this worker is ready for use
this.postMessage({
    'Type': 'Status',
    'Status': 'ready'
});