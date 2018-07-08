/*!
 * index.js - encryptionHandlers library Entry Point
 *
 * This library wraps node-jose with handlers for use in ExpressJs APIs
 *
 */
const jose = require( 'node-jose' );
const redisDriver = require('redis');

const keystore = {
    generate: generate,
    toJSON: toJSON,
    initialize: initialize
};

const standaloneKeystore = jose.JWK.createKeyStore();
let connectionAttempts = 0;
let hasLocalhostRedisFailed = false;
let hasExternalRedisFailed = false;
let shouldOperateStandalone = false;
let logger = {};
let client = {};


function initialize( appLogger ){
    logger = appLogger;

    //If there is a REDIS or YEDIS instance available then use that as our keystore otherwise operate locally
    client = redisDriver.createClient();
    client.on('ready', resetConnectionAttempts.bind(this));
    client.on('error', handleUnCaughtConnectionError.bind(this) );
    return keystore;
}

function getAllKeysInSharedStorage( includePrivateKeys, callback ){
    if ( !client.ready || !client.connected ) callback.send( new Error('Shared Keystore unavailable') );
    else {
        client.hgetall( "encryptionBusyBox::keystore", processRedisKeys );    
    }
    function processRedisKeys(err, keys) {
        if ( err ) {
            callback.send( err );
        } else {
            let jwkKeySet = [];
            for( let index in keys) {
                let key = JSON.parse( keys[index] );
                jwkKeySet.push( key );
            }
            jose.JWK.asKeyStore(jwkKeySet).then( sendKeys );
        }

        function sendKeys( ks ){
            let allKeys = ks.toJSON( includePrivateKeys );
            logger.info( {
                message: {
                    operation: "GET ALL keys from REDIS",
                    error: err,
                    keyCount: allKeys.length
                }
            });
            callback.send( allKeys );    
        }
    }
}


function toJSON( includePrivateKeys, callback ) {
    if (shouldOperateStandalone) {
        callback.send( standaloneKeystore.toJSON( includePrivateKeys) );
    } else {
        getAllKeysInSharedStorage( includePrivateKeys, callback);
    }
}

function generate( type, size, props, callback ){
    if (shouldOperateStandalone ) ks = standaloneKeystore;
    else {
        ks = jose.JWK.createKeyStore();
        if ( !client.ready || !client.connected ) callback.send( new Error('Shared Keystore unavailable') );
    }
    ks.generate( type, size, props ).then( marshalKeys);

    function marshalKeys( keyPair ) {
        let results = {
            key: keyPair.toJSON( true ),
            algorithms: keyPair.algorithms()
        };
        if (shouldOperateStandalone) {
            callback.send( results );
        } else {
            client.hset( "encryptionBusyBox::keystore", results.key.kid, JSON.stringify( results.key ), returnKeyIfSuccessfullySaved);
        }

        function returnKeyIfSuccessfullySaved(err, reply){
            logger.info( {
                message: {
                    operation: "SAVE key to REDIS",
                    keyID: results.key.kid,
                    error: err,
                    reply: reply
                }
            });
            if ( err ) {
                callback.send( err );
            } else {
                callback.send( results );
            }
        }    
    }
}

function logConnectionStatus( level, msg ){
    logger[level]( {
        message: {
            operation: msg,
            connectionAttempts: connectionAttempts,
            hasLocalhostRedisFailed: hasLocalhostRedisFailed,
            hasExternalRedisFailed: hasExternalRedisFailed,
            clientDetails: {
                address: client.address,
                connected: client.connected,
                ready: client.ready,
                retry_totaltime: client.retry_totaltime,
                retry_delay: client.retry_delay,
                eventCount: client._eventsCount,
                server_info: client.server_info
            }
        }
    });
}

function resetConnectionAttempts(){
    connectionAttempts = 0;
    logConnectionStatus( "info", "Successfully Connected to REDIS");
}

function handleUnCaughtConnectionError(err) {
    if ( err.code === "ECONNREFUSED" && err.syscall === "connect"){
        connectionAttempts++;
        if ( connectionAttempts >= 5 ){
            if ( !hasLocalhostRedisFailed ){
                hasLocalhostRedisFailed = true;
                connectionAttempts = 0;
                client.quit();
                client = redisDriver.createClient({ host: "redis"});
                client.on('ready', resetConnectionAttempts.bind(this));
                logConnectionStatus( "info", "Retrying with External REDIS Server");
            } else {
                hasExternalRedisFailed = true;
                shouldOperateStandalone = true;
                client.quit();
                client = { connected: false, ready: false };
                logConnectionStatus( "error", "Failed to Connect to External REDIS Server");
            }
        } else {
            logConnectionStatus( "info", "Retrying REDIS / YEDIS Connection");
        }
    } else {
        logConnectionStatus( "error", "General REDIS / YEDIS Error");
    }
}

module.exports = keystore;