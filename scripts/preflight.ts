import { modelHealth } from '../src/model';
const result = await modelHealth();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
