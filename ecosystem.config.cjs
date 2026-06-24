// PM2 process config. Named .cjs because package.json sets "type": "module".
module.exports = {
    apps: [
        {
            name: 'wab',
            script: 'server.js',
            exec_mode: 'fork',         // single stateful WhatsApp socket — must be fork, not cluster
            autorestart: true,
            max_memory_restart: '300M', // hard ceiling; creds persist so restart is seamless
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
}
