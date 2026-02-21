const log = `### 10:00\n\n**用户**: 你好\n\n**midou**: 你好！\n\n\n### 10:05\n\n**用户**: 测试\n\n**midou**: 测试成功\n\n\n`;
const userMsg = "测试";
const astMsg = "测试成功";
const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`### \\d{2}:\\d{2}\\n\\n\\*\\*用户\\*\\*: ${escapeRegExp(userMsg)}\\n\\n\\*\\*midou\\*\\*: ${escapeRegExp(astMsg)}\\n*`, 'g');
console.log("Before:");
console.log(log);
console.log("After:");
console.log(log.replace(pattern, ''));
