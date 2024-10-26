<img src="/public/img/logo.svg" width="128" align="right">

# WebhookProxy
A Discord webhook proxy, primarily for internal use with IFTTT.

# Installation Instructions
## Basic Setup

This setup just exposes the proxy publicly with no reverse proxy.  
Recommended to start with only, but you should probably use the correct setup as soon as possible.

1. Install Node.js 33 on your server.  
   The minimum requirement is v16.
```
sudo apt install nodejs
```
    

2. Install git.  
```
sudo apt install git
```
  

3. Install Redis 29 or its Windows equivalent Memurai 10  
   (Please note Memurai is paid software and you should probably just go put Redis in a Docker container instead on Windows, however for testing purposes Memurai will work fine).  
   You need at least v6.2 due to the commands used, though v7 and above is preferable.
```
sudo apt install redis
```
  

4.  Install pm2 and yarn
```
sudo apt install npm
npm i -g pm2 yarn
```
  

5.  Run following to clone the reposistory.
```
git clone https://github.com/slord399/discord_webhook_proxy_original
```  
  

6.  Enter the resultant webhook-proxy folder.
  

7.  Copy the .example.json files to the same name, just without .example  
```
cp config.example.json config.json
```
  

8.  Modify the files as you need, primarily config.json.
  

9.  Run following will install the necessary dependencies and build the project.
```
yarn && yarn build
```
  

10.  Run following will start the app under the name webhook-proxy in pm2.
```
pm2 start /root/discord_webhook_proxy_original/dist/index.js --name=webhook-proxy
```
  

11. Run webhook-proxy on startup, run 
```
pm2 startup
```
  

12. To save change to pm2
```
pm2 save
```
  

13. You should be good to go! 
  

14. Future updates just require a simple 
```
yarn update
```
  
  

## The Correct Setup

This setup involves using a reverse proxy instead of exposing the server directly and using a cluster instead of a single process.  
This is recommended (and the correct way), but a bit more complicated.  
This is how I actually run the proxy.  
This is how I used to run the proxy.  
I’m now using Cloudflare Tunnel, however this is still the recommended way of doing things that keeps it simple.

1.  Install nginx.  
    This will be our front-facing web server.
```
sudo apt install nginx
```
  

2. Install Node.js 33 on your server.
   The minimum requirement is v16.
```
sudo apt install nodejs
```
  

3. Install git. This is usually a default tool nowadays, but just grab it off of your package manager if you don’t have it.
```
sudo apt install git
```
  

4. Install Redis 29 or its Windows equivalent Memurai 10
   (please note Memurai is paid software and you should probably just go put Redis in a Docker container instead on Windows, however for testing purposes Memurai will work fine).  
   You need at least v6.2 due to the commands used, though v7 and above is preferable.
```
sudo apt install redis
```
  

5.  Install pm2 and yarn
```
sudo apt install npm
npm i -g pm2 yarn
```
  

6.  Run following to clone the proxy.
```
git clone https://github.com/slord399/discord_webhook_proxy_original
```
  

7.  Move to resultant webhook-proxy folder.
  

8.  Copy the .example.json files to the same name, just without .example.
```
cp config.example.json config.json
```
  

9.  Modify the files as you need, primarily config.json.
   *Update your configuration and set trustProxy to true.
  

10.  Run following will install the necessary dependencies and build the project.
```
yarn && yarn build
```
  

11.  Create a new site in nginx with the following configuration:
   (It is recommended you enable SSL and HTTP2 but this is out of scope for this setup)
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

        proxy_pass http://127.0.0.1:8080;
        proxy_redirect off;
    }
}
```
  

12.  Run following will start the app under the name webhook-proxy in pm2.
```
pm2 start /root/discord_webhook_proxy_original/dist/index.js --name=webhook-proxy
```
  

13.   If you wish to run this on startup, run 
```
pm2 startup
```
  
14.   Run to save change to pm2
```
pm2 save
```
  

13.  Reload nginx and pm2 node
```
service nginx reload
pm2 restart webhook-proxy
```
  

14. You should be good to go.
  


15. Future updates just require a simple 
```
yarn update
```
  

## Deploy pm2 as Cluster Mode  (Optional)
Depending on your load requirements, you may want to cluster WebhookProxy to deal with a large amount of servers.  
If you have >50 servers sending webhook requests frequently, you may need to scale.  
*Due to implementation, Publishers metrics shown on prometheus become negative value unintentionallly which is wrong.

1.   Delete existing webhook-proxy
   ```
pm2 delete webhook-proxy
```
  

2.   Deploy webhook-proxy in cluster mode
```
pm2 start /root/discord_webhook_proxy_original/dist/index.js --name=webhook-proxy -i 1
```
  

3.   webhook-proxy now run as clustered mode instead of the standard fork mode.
  

4.   From here, you can now scale the proxy up and down as you need to by doing 
     This is good for games that are growing that need to send a lot of webhook requests as you can just put on more workers as needed.
 ```
pm2 scale webhook-proxy <worker count>
 ```
  
  Please note that the benefits of clustering come from having multiple CPU cores. 
   If you do not have more than one core on your server, this will not benefit you and will most likely reduce performance from the overhead of clustering and the workers fighting each other for resources.
  

## Enabling Queues
A new feature of the proxy is the queue system. This requires some extra (but simple) setup.

1.  Install RabbitMQ from [here](https://www.rabbitmq.com/docs/install-debian).
  

2.  Edit your configuration to enable queues, and point to your RabbitMQ installation.  
     (it should just be the default value that I’ve provided, but in case you’ve changed anything you can set it here)
  

4.   Restart the proxy
```
pm2 restart webhook-proxy
```
  

5.  Start the queue processor with  
(Fork Mode / Cluster Mode)
```
pm2 start /root/discord_webhook_proxy_original/dist/queueProcessor.js --name=webhook-proxy-processor
```  
```
pm2 start /root/discord_webhook_proxy_original/dist/queueProcessor.js --name=webhook-proxy-processor -i 1
```
  

6.   Save change to pm2
```
pm2 save
```
  

7.  You should be good to go!  
      Try adding /queue onto end of your webhook requests URL!
  


## Usefult Note
### Reload/Restart
```
service nginx reload
```
```
service rabbitmq-server restart
```
```
pm2 restart webhook-proxy && pm2 restart webhook-proxy-processor && pm2 save
```
  

### Update the base system
```
apt update && apt upgrade && apt dist-upgrade
```
```
npm install pm2 -g && pm2 update && pm2 unstartup && nvm install node && npm install -g npm && pm2 startup
```
  

  
### Nginx related
```
/etc/nginx/nginx.conf
```
```
/etc/nginx/sites-enabled/default
```
```
nginx -t
```
  

### RabbitMQ related
* https://www.rabbitmq.com/docs/configure
* https://www.rabbitmq.com/docs/relocate
* https://www.rabbitmq.com/docs/logging
* https://www.rabbitmq.com/docs/networking
  
```
/etc/rabbitmq/rabbitmq.conf
```
```
/var/log/rabbitmq/rabbit.log
```
  

### PM2 related
```
pm2 logs
```
  

### Grafana Monitoring (https://www.rabbitmq.com/docs/prometheus)
*If you want to change settings of grafana, you need to install standard grafana and remove grafana section from yml.
```
docker-compose -f /root/rabbitmq-server/deps/rabbitmq_prometheus/docker/docker-compose-metrics.yml up -d
docker-compose -f /root/rabbitmq-server/deps/rabbitmq_prometheus/docker/docker-compose-overview.yml up -d
```
### To clear docker unused files which in case storage got bump up continuously
```
docker system prune
```

## Rabbitmq queue bump up (Suspect of process freeze)
Check pm2 logs for connection errors, if so,
```
pm2 restart webhook-proxy && pm2 restart webhook-proxy-processor && pm2 restart queueProcessor && pm2 save
```
