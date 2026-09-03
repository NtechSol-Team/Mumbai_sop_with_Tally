const os = require('os');

function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const addr of iface || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

const ip = lanAddress();
const port = process.env.PORT || 3100;
console.log(`\n  Network:  http://${ip ? `${ip}:${port}` : 'unavailable — no active network interface'}\n`);
