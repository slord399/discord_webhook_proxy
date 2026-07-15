const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', 'node_modules', 'parseurl', 'index.js');

if (fs.existsSync(targetPath)) {
    let content = fs.readFileSync(targetPath, 'utf8');

    // Safe WHATWG URL-based parse implementation to replace legacy url.parse
    const safeParseImplementation = `var parse = function(urlString) {
  if (typeof urlString !== 'string') {
    throw new TypeError("The 'urlString' argument must be of type string.");
  }
  let parsed;
  let isRelative = false;
  try {
    parsed = new URL(urlString);
  } catch (err) {
    try {
      parsed = new URL(urlString, 'http://localhost');
      isRelative = true;
    } catch (err2) {
      parsed = null;
    }
  }
  const result = url.Url ? Object.create(url.Url.prototype) : {};
  if (!parsed) {
    result.href = urlString;
    return result;
  }
  result.protocol = isRelative ? null : parsed.protocol;
  result.slashes = isRelative ? null : (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'ftp:' || parsed.protocol === 'gopher:' || parsed.protocol === 'file:');
  result.auth = isRelative ? null : (parsed.username || parsed.password ? (parsed.username + ':' + parsed.password) : null);
  result.host = isRelative ? null : parsed.host;
  result.port = isRelative ? null : (parsed.port || null);
  result.hostname = isRelative ? null : parsed.hostname;
  result.hash = parsed.hash || null;
  result.search = parsed.search || null;
  result.query = parsed.search ? parsed.search.slice(1) : null;
  result.pathname = parsed.pathname;
  result.path = result.pathname + (result.search || '');
  result.href = isRelative ? urlString : parsed.href;
  return result;
};`;

    if (content.includes('var parse = url.parse') && !content.includes('safeParseImplementation')) {
        content = content.replace('var parse = url.parse', safeParseImplementation);
        fs.writeFileSync(targetPath, content, 'utf8');
        console.log('Successfully patched parseurl with modern WHATWG URL parser.');
    } else {
        console.log('parseurl is already patched or var parse pattern not found.');
    }
} else {
    console.warn('parseurl index.js not found at ' + targetPath);
}
