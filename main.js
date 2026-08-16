//update no-ip, if changed.
const fs = require('fs').promises;
const os = require('os');

//ENV Parmeters:
//MYDU_FBIP: set FB IP, default 192.168.178.1
//MYDU_IP_STORAGE: set file to store old ips to, default /var/lib/misc/myduIpStore.json
//MYDU_V6INTERFACE: set interface to get ipv6 from, default enp0s31f6
//MYDU_V6PREFIX: set public ipv6 prefix, defaults to checking if starts with 2 or 3.
//MYDU_USERNAME
//MYDU_PASSWORD
// or
//MYDU_CREDFILE: set file to read credentials from, defaults to credentias.json
//MYDU_HOSTNAMES: hostnames to update, seperated by ,.
//MYDU_FORCE_UPDATE_DAYS: force an update after that many days without one, default 28. Set to 0 to disable.

const DEBUG = process.env.MYDU_DEBUG || false;

const DEFAULT_FORCE_UPDATE_DAYS = 28;

//some dyndns services delete hosts that were not updated for a while (usually a month),
//so we need to send an update from time to time, even if the ip did not change.
function getForceUpdateInterval() {
    let days = DEFAULT_FORCE_UPDATE_DAYS;
    const configured = process.env.MYDU_FORCE_UPDATE_DAYS;
    if (configured !== undefined && configured !== '') {
        const parsed = Number(configured);
        if (!Number.isFinite(parsed) || parsed < 0) {
            console.log(`Invalid MYDU_FORCE_UPDATE_DAYS: ${configured} -> using default of ${days} days.`);
        } else {
            days = parsed;
        }
    }
    return days * 24 * 60 * 60 * 1000; //0 -> forced updates are disabled.
}

async function getIPv4() {
    try {
        const fbIP =  process.env.MYDU_FBIP || '192.168.178.1';
        const url = 'http://' + fbIP + ':49000/igdupnp/control/WANIPConn1';
        const data = '<?xml version=\'1.0\' encoding=\'utf-8\'?> <s:Envelope s:encodingStyle=\'http://schemas.xmlsoap.org/soap/encoding/\' xmlns:s=\'http://schemas.xmlsoap.org/soap/envelope/\'> <s:Body> <u:GetExternalIPAddress xmlns:u=\'urn:schemas-upnp-org:service:WANIPConnection:1\' /> </s:Body> </s:Envelope>';
        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SoapAction': 'urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress'
            },
            body: data
        };
        const res = await fetch(url, options);
        const ipStr = await res.text();
        if (DEBUG) {
            console.log('IPv4 request:', ipStr, res.status);
        }
        if (res.status === 200) {
            //ok, extract ip:
            const start = ipStr.indexOf('<NewExternalIPAddress>') + '<NewExternalIPAddress>'.length;
            const end = ipStr.indexOf('</NewExternalIPAddress>');
            const ipv4 = ipStr.substring(start, end);
            if (DEBUG) {
                console.log('Found ipv4:', ipv4);
            }
            return ipv4;
        } else {
            console.log('Could not get ipv4:', res.status, res.statusText, ipStr);
        }
    } catch (e) {
        console.log('Could not get ipv4:', e);
    }
    return '';
}

async function getIPv6() {
    const interfaces = os.networkInterfaces();
    const targetInterface = process.env.MYDU_V6INTERFACE || 'enp0s31f6';
    const inf = interfaces[targetInterface];
    if (DEBUG) {
        console.log('Result from os:', inf);
    }
    if (inf) {
        for (const addr of inf) {
            if (addr.family === 'IPv6') {
                if (process.env.MYDU_V6PREFIX && addr.address.startsWith(process.env.MYDU_V6PREFIX)) {
                    if (DEBUG) {
                        console.log('Found global v6 address:', addr);
                    }
                    return addr.address;
                }
                if (addr.address.startsWith('2') || addr.address.startsWith('3')) {
                    if (DEBUG) {
                        console.log('Found global v6 address:', addr);
                    }
                    return addr.address;
                }
            }
        }
    }
    console.log('No ipv6 found...');
}

//the service reports errors as plain text, so we need to look at the body of the response.
function handleErrorResponse(ips, status, body) {
    //check for errors -> if something that bad did happen, store in ips file and block further updates until resolved.
    if (body.includes('nohost')) {
        console.error('No hosts specified.'); //should not happpend, because we check that above? -> did protocol change?
        ips.nohosts = true;
        return 'failure';
    }
    if (body.includes('badauth')) {
        console.error('Could not login -> wrong credentials.');
        ips.badauth = true;
        return 'failure';
    }
    if (body.includes('badagent')) {
        console.error('noip blocked my software.. AHRG... :-(');
        ips.badagent = true;
        return 'failure';
    }
    if (body.includes('abuse')) {
        console.error('Blocked due to abuse...??? AHRG... :-(');
        ips.abuse = true;
        return 'failure';
    }
    if (body.includes('911') || status >= 500) {
        console.error('Error on noip site. Try again in 30 Minutes... hm.');
        ips.waitFor30Minutes = true;
        return 'failure';
    }
    return false;
}

async function doUpdate(ips) {
    try {
        let credentials = { username: '', password: ''};
        if (process.env.MYDU_USERNAME && process.env.MYDU_PASSWORD) {
            credentials.username = process.env.MYDU_USERNAME;
            credentials.password = process.env.MYDU_PASSWORD;
        } else {
            credentials = JSON.parse(await fs.readFile(process.env.MYDU_CREDFILE || 'credentials.json', 'utf-8'));
        }
        if (!process.env.MYDU_HOSTNAMES) {
            console.error('Please set Hostnames in MYDU_HOSTNAMES environment variable.');
            return false;
        }
        const url = `https://dynupdate.no-ip.com/nic/update?hostname=${process.env.MYDU_HOSTNAMES}&myip=${ips.v4}${ips.v6 ? ',' + ips.v6 : ''}`;
        const options = {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64'),
                'User-Agent': 'Mobo DirectUpdate Client/Linux-0.0.1 garfonso@mobo.info'
            }
        };
        let res;
        let answers;
        try {
            res = await fetch(url, options);
            answers = await res.text();
        } catch (e) {
            //fetch only rejects if the request could not be sent (or the answer not be read) at all.
            console.log('Error during update:', e);
            const code = (e.cause && e.cause.code) || e.code;
            if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
                console.log('Network error. Let\'s wait until it is up again.');
                return 'network';
            }
            return false;
        }
        if (DEBUG) {
            console.log('Result:', answers, res.status);
        }
        //unlike axios, fetch does not reject on error codes -> check ourselves.
        if (!res.ok) {
            console.log('Error during update:', res.status, res.statusText, answers);
            return handleErrorResponse(ips, res.status, answers);
        }

        const hosts = process.env.MYDU_HOSTNAMES.split(',');
        let index = 0;
        //process line for line
        let realUpdate = false;
        for (const answer of answers.split('\n')) {
            const [state, ip] = answer.split(' ');
            if (state === 'good') {
                console.log(`Updated host ${hosts[index]} to ${ip}`);
                realUpdate = true;
            } else if (state === 'nochg') {
                if (DEBUG) {
                    console.log(`${hosts[index]} already was set to ${ip}`);
                }
            }
            index += 1;
        }
        if (realUpdate) {
            return 'realUpdate';
        }
        return true;
    } catch (e) {
        //e.g. the credentials file could not be read.
        console.log('Error during update:', e);
    }
    return false;
}

async function main() {
    const storageFile = process.env.MYDU_IP_STORAGE || '/var/lib/misc/myduIpStore.json';
    const oldIps = {v4: '', v6: ''};
    let lastUpdate = 0; //0 -> unknown, i.e. we never stored a successful update.
    let retryAfterError = false;
    try {
        const contents = await fs.readFile(storageFile, 'utf-8');
        const obj = JSON.parse(contents);
        oldIps.v4 = obj.v4;
        oldIps.v6 = obj.v6;

        if (obj.lastUpdate) {
            const parsed = Date.parse(obj.lastUpdate);
            if (!Number.isNaN(parsed)) {
                lastUpdate = parsed;
            }
        }
        if (!lastUpdate) {
            //storage file was written by an older version -> use its modification time as a starting point.
            try {
                const stats = await fs.stat(storageFile);
                lastUpdate = stats.mtime.getTime();
            } catch (e) {
                console.log('Could not read modification time of storage file.', e);
            }
        }

        if (obj.nohosts) {
            console.error('Did you correct the nohosts problem? - if so, delete the ip storage at ' + storageFile);
            process.exit(10);
        }
        if (obj.badauth) {
            console.error('Did you correct the bad auth problem? - if so, delete the ip storage at ' + storageFile);
            process.exit(11);
        }
        if (obj.abuse) {
            console.error('Did you correct the abuse problem? - if so, delete the ip storage at ' + storageFile);
            process.exit(12);
        }
        if (obj.badagent) {
            console.error('Did you correct the bad agent problem? - if so, delete the ip storage at ' + storageFile);
            process.exit(13);
        }

        if (obj.waitFor30Minutes) {
            const stats = await fs.stat(storageFile);
            if (DEBUG) {
                console.log(stats.mtime);
            }
            const timePassed = Date.now() - stats.mtime.getTime();
            if (timePassed < 30 * 60 * 1000) {
                console.error(`No ip hat issue ${Math.floor(timePassed / 1000 / 60)} minutes ago. Wait some more.`);
                return;
            }
            //the ips were already stored during the failed attempt, so retry even if they did not change.
            retryAfterError = true;
        }

    } catch (e) {
        //ok, file does not yet exist. -> ignore.
        console.log('Storage file does not exist or is corrupt -> no old ips.', e);
    }

    //get current ips:
    const newIps = {
        v4: await getIPv4(),
        v6: await getIPv6()
    };

    if (DEBUG) {
        console.log('Found ips:', newIps, 'storedIps:', oldIps);
    }

    //check if ips did change - kind of a hack
    const ipsChanged = JSON.stringify(oldIps) !== JSON.stringify(newIps);

    //force an update once in a while, so the hosts do not get deleted by the service.
    const forceUpdateInterval = getForceUpdateInterval();
    const timeSinceLastUpdate = lastUpdate ? Date.now() - lastUpdate : Number.POSITIVE_INFINITY;
    const forcedUpdate = forceUpdateInterval > 0 && timeSinceLastUpdate >= forceUpdateInterval;
    if (forcedUpdate && !ipsChanged) {
        const days = timeSinceLastUpdate === Number.POSITIVE_INFINITY ? 'unknown' : Math.floor(timeSinceLastUpdate / 1000 / 60 / 60 / 24);
        console.log(`Last update was ${days} days ago -> forcing an update, even though the ips did not change.`);
    }

    if ((ipsChanged || forcedUpdate || retryAfterError) && (newIps.v4 || newIps.v6)) {
        const updateDone = await doUpdate(newIps);
        if (updateDone === 'network') {
            //update never reached the service -> do not store anything, so we retry with the same data later.
            return;
        }
        if (updateDone) {
            const toStore = Object.assign({}, newIps);
            if (updateDone === 'failure') {
                //nothing was updated -> keep the old timestamp, so the forced update is not postponed by an error.
                if (lastUpdate) {
                    toStore.lastUpdate = new Date(lastUpdate).toISOString();
                }
            } else {
                toStore.lastUpdate = new Date().toISOString();
            }
            if (DEBUG) {
                console.log('Storing', toStore, 'to', storageFile);
            }
            await fs.writeFile(storageFile, JSON.stringify(toStore, null, 2));
        } else {
            console.log('No update done... hm');
            process.exit(50);
        }
        if (updateDone === 'realUpdate') {
            process.exit(100);
        }
        if (updateDone === 'failure') {
            process.exit(50); // trigger mail..
        }
    } else {
        if (DEBUG) {
            console.log('No update needed or possible because no ip: ', newIps);
        }
    }
}

main().then(() => {
    if (DEBUG) {
        console.log('All done. Yay.');
    }
    process.exit(0);
});
