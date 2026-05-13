const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');
let stack = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('try {')) {
        stack.push(i + 1);
    }
    if (line.includes('} catch')) {
        if (stack.length > 0) {
            stack.pop();
        } else {
            console.log(`Unmatched catch at line ${i + 1}`);
        }
    }
}

console.log('Unclosed try blocks at lines:', stack);
