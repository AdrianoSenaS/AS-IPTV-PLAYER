const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const width = 320;
const height = 180;
const outputPath = path.join(__dirname, '..', 'assets', 'images', 'tv-banner-320x180.png');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function setPixel(buffer, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  buffer[index] = r;
  buffer[index + 1] = g;
  buffer[index + 2] = b;
  buffer[index + 3] = a;
}

function blendPixel(buffer, x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  const dstA = buffer[index + 3] / 255;
  const srcA = clamp(alpha, 0, 255) / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buffer[index] = Math.round((r * srcA + buffer[index] * dstA * (1 - srcA)) / outA);
  buffer[index + 1] = Math.round((g * srcA + buffer[index + 1] * dstA * (1 - srcA)) / outA);
  buffer[index + 2] = Math.round((b * srcA + buffer[index + 2] * dstA * (1 - srcA)) / outA);
  buffer[index + 3] = Math.round(outA * 255);
}

function fillRect(buffer, left, top, rectWidth, rectHeight, color) {
  for (let y = top; y < top + rectHeight; y += 1) {
    for (let x = left; x < left + rectWidth; x += 1) {
      setPixel(buffer, x, y, color[0], color[1], color[2], color[3] ?? 255);
    }
  }
}

function fillCircle(buffer, centerX, centerY, radius, color, alphaScale = 1) {
  const minX = Math.floor(centerX - radius);
  const maxX = Math.ceil(centerX + radius);
  const minY = Math.floor(centerY - radius);
  const maxY = Math.ceil(centerY + radius);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > radius) continue;
      const softness = 1 - distance / radius;
      blendPixel(buffer, x, y, color[0], color[1], color[2], Math.round((color[3] ?? 255) * softness * alphaScale));
    }
  }
}

function fillRoundedRect(buffer, left, top, rectWidth, rectHeight, radius, color) {
  for (let y = top; y < top + rectHeight; y += 1) {
    for (let x = left; x < left + rectWidth; x += 1) {
      const rx = x < left + radius ? left + radius : x > left + rectWidth - radius - 1 ? left + rectWidth - radius - 1 : x;
      const ry = y < top + radius ? top + radius : y > top + rectHeight - radius - 1 ? top + rectHeight - radius - 1 : y;
      const dx = x - rx;
      const dy = y - ry;
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(buffer, x, y, color[0], color[1], color[2], color[3] ?? 255);
      }
    }
  }
}

// ── Bitmap font 5×7 ──────────────────────────────────────────────────────────
const FONT5X7 = {
  ' ': [0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b00000],
  'A': [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'B': [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
  'C': [0b01111,0b10000,0b10000,0b10000,0b10000,0b10000,0b01111],
  'D': [0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
  'E': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
  'F': [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
  'G': [0b01111,0b10000,0b10000,0b10111,0b10001,0b10001,0b01111],
  'H': [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'I': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b11111],
  'J': [0b00111,0b00001,0b00001,0b00001,0b10001,0b10001,0b01110],
  'K': [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'L': [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
  'M': [0b10001,0b11011,0b10101,0b10001,0b10001,0b10001,0b10001],
  'N': [0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
  'O': [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'P': [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
  'Q': [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
  'R': [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
  'S': [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
  'T': [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  'U': [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'V': [0b10001,0b10001,0b10001,0b10001,0b01010,0b01010,0b00100],
  'W': [0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
  'X': [0b10001,0b01010,0b00100,0b00100,0b00100,0b01010,0b10001],
  'Y': [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
  'Z': [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
  'a': [0b00000,0b01110,0b00001,0b01111,0b10001,0b10011,0b01101],
  'b': [0b10000,0b10000,0b11110,0b10001,0b10001,0b10001,0b11110],
  'c': [0b00000,0b01110,0b10001,0b10000,0b10000,0b10001,0b01110],
  'd': [0b00001,0b00001,0b01111,0b10001,0b10001,0b10001,0b01111],
  'e': [0b00000,0b01110,0b10001,0b11111,0b10000,0b10000,0b01111],
  'f': [0b00110,0b01001,0b01000,0b11100,0b01000,0b01000,0b01000],
  'g': [0b00000,0b01111,0b10001,0b10001,0b01111,0b00001,0b01110],
  'h': [0b10000,0b10000,0b11110,0b10001,0b10001,0b10001,0b10001],
  'i': [0b00100,0b00000,0b01100,0b00100,0b00100,0b00100,0b01110],
  'j': [0b00010,0b00000,0b00110,0b00010,0b00010,0b10010,0b01100],
  'k': [0b10000,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'l': [0b01100,0b00100,0b00100,0b00100,0b00100,0b00100,0b01110],
  'm': [0b00000,0b11010,0b10101,0b10101,0b10001,0b10001,0b10001],
  'n': [0b00000,0b11110,0b10001,0b10001,0b10001,0b10001,0b10001],
  'o': [0b00000,0b01110,0b10001,0b10001,0b10001,0b10001,0b01110],
  'p': [0b00000,0b11110,0b10001,0b10001,0b11110,0b10000,0b10000],
  'q': [0b00000,0b01111,0b10001,0b10001,0b01111,0b00001,0b00001],
  'r': [0b00000,0b10110,0b11001,0b10000,0b10000,0b10000,0b10000],
  's': [0b00000,0b01111,0b10000,0b01110,0b00001,0b00001,0b11110],
  't': [0b01000,0b01000,0b11110,0b01000,0b01000,0b01001,0b00110],
  'u': [0b00000,0b10001,0b10001,0b10001,0b10001,0b10011,0b01101],
  'v': [0b00000,0b10001,0b10001,0b10001,0b01010,0b01010,0b00100],
  'w': [0b00000,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
  'x': [0b00000,0b10001,0b01010,0b00100,0b01010,0b10001,0b00000],
  'y': [0b00000,0b10001,0b10001,0b01111,0b00001,0b10001,0b01110],
  'z': [0b00000,0b11111,0b00010,0b00100,0b01000,0b10000,0b11111],
};

function drawText(buffer, text, startX, startY, scale, color) {
  let cx = startX;
  for (const ch of text) {
    const glyph = FONT5X7[ch] || FONT5X7[' '];
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row] & (1 << (4 - col))) {
          fillRect(buffer, cx + col * scale, startY + row * scale, scale, scale, color);
        }
      }
    }
    cx += (5 + 1) * scale;
  }
}

function drawTriangle(buffer, points, color) {
  const [p1, p2, p3] = points;
  const minX = Math.floor(Math.min(p1.x, p2.x, p3.x));
  const maxX = Math.ceil(Math.max(p1.x, p2.x, p3.x));
  const minY = Math.floor(Math.min(p1.y, p2.y, p3.y));
  const maxY = Math.ceil(Math.max(p1.y, p2.y, p3.y));

  const area = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const total = area(p1, p2, p3);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const point = { x: x + 0.5, y: y + 0.5 };
      const w1 = area(point, p2, p3) / total;
      const w2 = area(p1, point, p3) / total;
      const w3 = area(p1, p2, point) / total;
      if (w1 >= 0 && w2 >= 0 && w3 >= 0) {
        setPixel(buffer, x, y, color[0], color[1], color[2], color[3] ?? 255);
      }
    }
  }
}

const pixels = Buffer.alloc(width * height * 4);

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const tx = x / (width - 1);
    const ty = y / (height - 1);
    const t = clamp(tx * 0.45 + ty * 0.9, 0, 1);
    setPixel(
      pixels,
      x,
      y,
      mix(5, 15, t),
      mix(7, 23, t),
      mix(15, 38, t),
      255
    );
  }
}

fillRect(pixels, 0, 0, width, 16, [255, 122, 24, 255]);
fillCircle(pixels, 265, 90, 80, [255, 59, 48, 95], 0.85);
fillCircle(pixels, 245, 120, 46, [255, 143, 58, 115], 0.9);
fillRoundedRect(pixels, 28, 46, 92, 92, 22, [19, 26, 43, 255]);
fillRoundedRect(pixels, 34, 52, 80, 80, 18, [255, 122, 24, 255]);
fillRoundedRect(pixels, 42, 60, 64, 64, 16, [11, 15, 26, 255]);
drawTriangle(
  pixels,
  [
    { x: 62, y: 76 },
    { x: 62, y: 108 },
    { x: 89, y: 92 },
  ],
  [248, 250, 252, 255]
);

// ── Texto "As Iptv Player" à direita do ícone ─────────────────────────────
const textX = 138;
const scale1 = 4; // título principal
const scale2 = 3; // subtítulo
const line1 = 'As Iptv';
const line2 = 'Player';
const charW1 = (5 + 1) * scale1;
const charW2 = (5 + 1) * scale2;
const line1W = line1.length * charW1 - scale1;
const line2W = line2.length * charW2 - scale2;
const textAreaW = 320 - textX - 12;
const x1 = textX + Math.max(0, Math.floor((textAreaW - line1W) / 2));
const x2 = textX + Math.max(0, Math.floor((textAreaW - line2W) / 2));

// sombra suave
drawText(pixels, line1, x1 + 1, 56 + 1, scale1, [0, 0, 0, 180]);
drawText(pixels, line1, x1, 56, scale1, [255, 255, 255, 255]);

drawText(pixels, line2, x2 + 1, 56 + (7 + 2) * scale1 + 1, scale2, [0, 0, 0, 160]);
drawText(pixels, line2, x2, 56 + (7 + 2) * scale1, scale2, [255, 140, 30, 255]);

const raw = Buffer.alloc((width * 4 + 1) * height);
for (let y = 0; y < height; y += 1) {
  const rowStart = y * (width * 4 + 1);
  raw[rowStart] = 0;
  pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
}

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 6;
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  signature,
  pngChunk('IHDR', ihdr),
  pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0)),
]);

fs.writeFileSync(outputPath, png);
console.log(outputPath);
