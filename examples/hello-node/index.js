const http = require('http');

const port = parseInt(process.env.PORT || '3000', 10);

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from Brimble deployment!\n');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});
