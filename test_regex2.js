const log = `### 10:00\n\n**用户**: 你好\n世界\n\n**midou**: 你好！\n世界！\n\n\n`;
const userMsg = "你好\n世界";
const astMsg = "你好！\n世界！";
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`### \\d{2}:\\d{2}\\n\\n\\*\\*用户\\*\\*: ${escapeRegExp(userMsg)}\\n\\n\\*\\*midou\\*\\*: ${escapeRegExp(astMsg)}\\n*`, 'g');
console.log("After:");
console.log(log.replace(pattern, ''));
