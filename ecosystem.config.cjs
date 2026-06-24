// PM2 process config. Named .cjs because package.json sets "type": "module".
module.exports = {
    apps: [
        {
            name: 'wab',
            script: 'server.js',
            instances: 1,              // a single WhatsApp connection — never cluster this
            autorestart: true,
            max_memory_restart: '300M', // hard ceiling; creds persist so restart is seamless
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
}
