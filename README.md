# directupdateclient
a simple direct update client for no ip, supporting ipv4 and ipv6

Currently can only update no-ip.
IPv4 is retrieved from fritzBox.
IPv6 is retrieved from local interface.

Use service files to check for update every 5 minutes.
Use environment file to configure.

Following parameters can be set:

| Environment variable | setting                                                                      | default                                                  |
|----------------------|------------------------------------------------------------------------------|----------------------------------------------------------|
| MYDU_FBIP            | set FB IP                                                                    | 192.168.178.1                                            |
| MYDU_IP_STORAGE      | set file to store old ips to                                                 | /var/lib/misc/myduIpStore.json                           |
| MYDU_V6INTERFACE     | set interface to get ipv6 from                                               | enp0s31f6                                                |
| MYDU_V6PREFIX        | set public ipv6 prefix                                                       | defaults to checking if starts with 2 or 3.              |
| MYDU_USERNAME        | no ip username                                                               | no default. Use Username & password or credentials file. |
| MYDU_PASSWORD        | no ip password                                                               |                                                          |
| MYDU_CREDFILE        | set file to read credentials from                                            | credentias.json in working dir.                          |
| MYDU_HOSTNAMES       | hostnames to update, seperated by ,.                                         | no default. Need to set                                  |
| MYDU_DEBUG           | enable debug logging (to activate set to anything that will be truthy in JS) | default off                                              |

## Changelog
<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->
### 1.0.1 (2023-09-06)
* ignore not-found network error for now.
