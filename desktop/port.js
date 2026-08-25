'use strict';

const net = require('node:net');

function probePort(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    const onError = (error) => {
      server.removeAllListeners();
      if (error.code === 'EADDRINUSE') resolve(null);
      else reject(error);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      const actualPort = server.address().port;
      server.close(() => resolve(actualPort));
    });
  });
}

async function findAvailablePort({ preferredPort = 4876, host = '127.0.0.1' } = {}) {
  const preferred = await probePort(preferredPort, host);
  if (preferred) return preferred;
  return probePort(0, host);
}

module.exports = { findAvailablePort };
