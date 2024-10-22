<img src="/public/img/logo.svg" width="128" align="right">

# WebhookProxy
A Discord webhook proxy, primarily for internal use with IFTTT.

# Installation Instructions
## Basic Setup

This setup just exposes the proxy publicly with no reverse proxy. Recommended to start with only, but you should probably use the correct setup as soon as possible.

1. Install Node.js 33 on your server. This can be done through a package manager or through nvm 16. The minimum requirement is v16.
```
sudo apt install nodejs
```
2. Install git. This is usually a default tool nowadays, but just grab it off of your package manager if you don’t have it.
```
sudo apt install git
```
4. Install Redis 29 or its Windows equivalent Memurai 10 (please note Memurai is paid software and you should probably just go put Redis in a Docker container instead on Windows, however for testing purposes Memurai will work fine). You need at least v6.2 due to the commands used, though v7 and above is preferable.
```
sudo apt install redis
```
5.  Install pm2 and yarn
```
sudo apt install npm
npm i -g pm2 yarn
```
6.  Run
```
git clone https://github.com/LewisTehMinerz/webhook-proxy
```
to clone the proxy.

7.  Enter the resultant webhook-proxy folder.
8.  Copy the .example.json files to the same name, just without .example (e.g., config.example.json → config.json).
   ```
cp config.example.json config.json
```
9.  Modify the files as you need, primarily config.json.
10.  Run
```
yarn && yarn build
```
This will install the necessary dependencies and build the project.

12.  Run
```
pm2 start dist/index.js --name=webhook-proxy
```
 This will start the app under the name webhook-proxy in pm2.
     If you wish to run this on startup, run 
```
pm2 startup
```
follow the instructions there, and then run
```
pm2 save.
```
   You should be good to go! 
   Future updates just require a simple 
```
yarn update
```

## The Correct Setup

This setup involves using a reverse proxy instead of exposing the server directly and using a cluster instead of a single process. This is recommended (and the correct way), but a bit more complicated. This is how I actually run the proxy. This is how I used to run the proxy. I’m now using Cloudflare Tunnel, however this is still the recommended way of doing things that keeps it simple.

1.  Install nginx. This will be our front-facing web server.
```
sudo apt install nginx
```
3.  Update your configuration and set trustProxy to true.
4.  Create a new site in nginx with the following configuration:
```
server {
    listen 80;

    server_name <domain name>;

    location / {
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Host $http_host;
        proxy_set_header X-NginX-Proxy true;

        proxy_pass http://127.0.0.1:<port>;
        proxy_redirect off;
    }
}
```
(it is recommended you enable SSL and HTTP2 but this is out of scope for this setup)

4.  Reload nginx and
```
pm2 restart webhook-proxy
```
You should be good to go.

6.  (Optional) Depending on your load requirements, you may want to cluster WebhookProxy to deal with a large amount of Roblox servers. If you have >50 servers sending webhook requests frequently, you may need to scale. To do so, run
   ```
pm2 delete webhook-proxy
```
and then 
```
run pm2 start /root/discord_webhook_proxy_original/dist/index.js --name=webhook-proxy -i 1
```
This will run it in a clustered mode instead of the standard fork mode.
        From here, you can now scale the proxy up and down as you need to by doing 
 ```
pm2 scale webhook-proxy <worker count>
 ```
This is good for games that are growing that need to send a lot of webhook requests as you can just put on more workers as needed.
Please note that the benefits of clustering come from having multiple CPU cores. 
If you do not have more than one core on your server, this will not benefit you and will most likely reduce performance from the overhead of clustering and the workers fighting each other for resources.

## Enabling Queues

A new feature of the proxy is the queue system. This requires some extra (but simple) setup.

1.  Install RabbitMQ 16.
2.  Edit your configuration to enable queues, and point to your RabbitMQ installation (it should just be the default value that I’ve provided, but in case you’ve changed anything you can set it here).
3.   Restart the proxy
```
pm2 restart webhook-proxy
```
5.  Start the queue processor with
```
pm2 start pm2 start dist/queueProcessor.js --name=webhook-proxy-processor
```
Run
```
pm2 save
```
as well if necessary.

7.  You should be good to go! Try adding /queue onto your webhook requests!

With the newer updates of the proxy, you can now just run yarn update and, as long as you have the setup as described in this guide, it will automatically update the proxy for you. If a yarn update fails, try running it again. It could be that I updated the script.
