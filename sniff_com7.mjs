import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

const port = new SerialPort({ path: 'COM7', baudRate: 115200 });
const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));
let count = 0;

parser.on('data', (line) => {
  process.stdout.write('[COM7] ' + line + '\n');
  count++;
  if (count >= 80) {
    port.close(() => process.exit(0));
  }
});

port.on('error', (e) => {
  process.stderr.write('PORT ERROR: ' + e.message + '\n');
  process.exit(1);
});

setTimeout(() => {
  try { port.close(); } catch (e) {}
  process.exit(0);
}, 18000);
