//update no-ip, if changed.
const fs = require('fs').promises;
const axios = require('axios').default;
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

const DEBUG = true;

async function getIPv4() {
    try {
        const fbIP =  process.env.MYDU_FBIP || '192.168.178.1';
        const url = 'http://' + fbIP + ':49000/igdupnp/control/WANIPConn1';
        const options = {
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SoapAction': 'urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress'
            }
        };
        const data = '<?xml version=\'1.0\' encoding=\'utf-8\'?> <s:Envelope s:encodingStyle=\'http://schemas.xmlsoap.org/soap/encoding/\' xmlns:s=\'http://schemas.xmlsoap.org/soap/envelope/\'> <s:Body> <u:GetExternalIPAddress xmlns:u=\'urn:schemas-upnp-org:service:WANIPConnection:1\' /> </s:Body> </s:Envelope>';
        const res = await axios.post(url, data, options);
        if (DEBUG) {
            console.log('IPv4 request:', res.data, res.status);
        }
        if (res.status === 200) {
            //ok, extract ip:
            const ipStr = res.data;
            const start = ipStr.indexOf('<NewExternalIPAddress>') + '<NewExternalIPAddress>'.length;
            const end = ipStr.indexOf('</NewExternalIPAddress>');
            const ipv4 = ipStr.substring(start, end);
            if (DEBUG) {
                console.log('Found ipv4:', ipv4);
            }
            return ipv4;
        } else {
            console.log('Could not get ipv4:', res.status, res.statusText, res.data);
        }
    } catch (e) {
        console.log('Could not ipv4:', e);
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
    for (const addr of inf) {
        if (addr.family === 'IPv6') {
            if (process.env.MYDU_V6PREFIX && addr.address.startsWith(process.env.MYDU_V6PREFIX)) {
                if (DEBUG) {
                    console.log('Found global v6 address:', addr);
                    return addr.address;
                }
            }
            if (addr.address.startsWith('2') || addr.address.startsWith('3')) {
                if (DEBUG) {
                    console.log('Found global v6 address:', addr);
                    return addr.address;
                }
            }
        }
    }
    console.log('No ipv6 found...');
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
        const url = `https://dynupdate.no-ip.com/nic/update?hostname=${process.env.MYDU_HOSTNAMES}&myip=${ips.v4}${ips.v6 ? ',' + ips.v6 : ''}`
        const options = {
            auth: credentials,
            headers: {
                'User-Agent': 'Mobo DirectUpdate Client/Linux-0.0.1 garfonso@mobo.info'
            }
        }
        const res = await axios.get(url, options);
        if (DEBUG) {
            console.log('Result:', res.data, res.status);
        }

        //check for errors -> if something that bad did happen, store in ips file and block further updates until resolved.
        if (res.data.includes('nohost')) {
            console.error('No hosts specified.'); //should not happpend, because we check that above? -> did protocol change?
            ips.nohosts = true;
            return true;
        }
        if (res.data.includes('badauth')) {
            console.error('Could not login -> wrong credentials.');
            ips.badauth = true;
            return true;
        }
        if (res.data.includes('badagent')) {
            console.error('noip blocked my software.. AHRG... :-(');
            ips.badagent = true;
            return true;
        }
        if (res.data.includes('abuse')) {
            console.error('Blocked due to abuse...??? AHRG... :-(');
            ips.abuse = true;
            return true;
        }
        if (res.data.includes('911')) {
            console.error('Error on noip site. Try again in 30 Minutes... hm.');
            ips.waitFor30Minutes = true;
            return true;
        }

        if (res.status === 200) {
            const answers = res.data;
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
        } else if (res.status >= 500) {
            console.error('Error on noip site. Try again in 30 Minutes... hm.');
            ips.waitFor30Minutes = true;
            return true;
        }
    } catch (e) {
        console.log('Error during update:', e);
    }
    return false;
}

async function main() {
    const storageFile = process.env.MYDU_IP_STORAGE || '/var/lib/misc/myduIpStore.json';
    const oldIps = {v4: '', v6: ''};
    try {
        const contents = await fs.readFile(storageFile, 'utf-8');
        const obj = JSON.parse(contents);
        oldIps.v4 = obj.v4;
        oldIps.v6 = obj.v6;

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
        }

    } catch (e) {
        //ok, file does not yet exist. -> ignore.
        console.log('Storage file does not exist or is corrupt -> no old ips.', e);
    }

    //get current ips:
    const newIps = {
        v4: await getIPv4(),
        v6: await getIPv6()
    }

    if (DEBUG) {
        console.log('Found ips:', newIps, 'storedIps:', oldIps);
    }

    //check if ips did change - kind of a hack
    if (JSON.stringify(oldIps) !== JSON.stringify(newIps)) {
        const updateDone = await doUpdate(newIps);
        if (updateDone) {
            await fs.writeFile(storageFile, JSON.stringify(newIps, null, 2));
        }
        if (updateDone === 'realUpdate') {
            process.exit(100);
        }
    } else {
        if (DEBUG) {
            console.log('No update needed.');
        }
    }
}

main().then(() => {
    if (DEBUG) {
        console.log('All done. Yay.');
    }
    process.exit(0);
});
