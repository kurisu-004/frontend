// scripts/generate-test-pdf.mjs
// 2026-09-12 新增：生成 sample-drawing.pdf 给工序制定页 dev:dummy 模式用作图纸预览测试。
// 用 pdf-lib 在 src/views/production/__fixtures__ 下生成 3 页 A4 PDF（外框/圆孔/尺寸标注/工艺说明）。
//
// 运行：node scripts/generate-test-pdf.mjs（已加 package.json 脚本 fixture:pdf）
//       npm run fixture:pdf
//
// 注意：pdf-lib 的 StandardFonts 走 WinAnsi 编码，不支持中文。本脚本所有文字用拉丁字符
// 表达（生产环境真接入图纸后用 COS 直传的 PDF，中文由源文件自带）。测试目的是验证滚轮缩放、
// 拖动平移、多页切换等交互，文字可读性不是重点。

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = `${__dirname}/../src/views/production/__fixtures__/sample-drawing.pdf`;

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.HelveticaBold);
const fontRegular = await pdf.embedFont(StandardFonts.Helvetica);

const W = 595;
const H = 842; // A4 portrait (pt)

// Page 1: Title + outer rectangle + circle + triangle
{
  const p = pdf.addPage([W, H]);
  p.drawText('Sample Drawing - Page 1 (1/3)', {
    x: 50,
    y: 780,
    size: 18,
    font,
    color: rgb(0.2, 0.3, 0.5),
  });
  p.drawText('DWG-TEST-001 / Process Design dev preview test', {
    x: 50,
    y: 750,
    size: 11,
    font: fontRegular,
    color: rgb(0.4, 0.4, 0.4),
  });
  // Outer rectangle 420x280
  p.drawRectangle({
    x: 80,
    y: 400,
    width: 420,
    height: 280,
    borderColor: rgb(0.8, 0.2, 0.2),
    borderWidth: 2,
  });
  p.drawText('Outer Frame 420x280', {
    x: 90,
    y: 670,
    size: 9,
    font: fontRegular,
    color: rgb(0.8, 0.2, 0.2),
  });
  // Circle (hole) radius=60
  p.drawCircle({
    x: 290,
    y: 540,
    size: 60,
    borderColor: rgb(0.2, 0.5, 0.8),
    borderWidth: 1.5,
  });
  p.drawText('R60', {
    x: 278,
    y: 480,
    size: 9,
    font: fontRegular,
    color: rgb(0.2, 0.5, 0.8),
  });
  // Triangle (3 lines)
  p.drawLine({
    start: { x: 200, y: 420 },
    end: { x: 380, y: 420 },
    color: rgb(0.5, 0.5, 0.5),
    thickness: 1,
  });
  p.drawLine({
    start: { x: 200, y: 420 },
    end: { x: 290, y: 380 },
    color: rgb(0.5, 0.5, 0.5),
    thickness: 1,
  });
  p.drawLine({
    start: { x: 380, y: 420 },
    end: { x: 290, y: 380 },
    color: rgb(0.5, 0.5, 0.5),
    thickness: 1,
  });
}

// Page 2: Dimensions & tolerances
{
  const p = pdf.addPage([W, H]);
  p.drawText('Sample Drawing - Page 2 (2/3)', {
    x: 50,
    y: 780,
    size: 18,
    font,
    color: rgb(0.2, 0.3, 0.5),
  });
  p.drawText('Dimensions & Tolerances', {
    x: 50,
    y: 755,
    size: 12,
    font: fontRegular,
  });
  // Horizontal dimension line with end ticks
  p.drawLine({
    start: { x: 100, y: 600 },
    end: { x: 500, y: 600 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
  p.drawLine({
    start: { x: 100, y: 595 },
    end: { x: 100, y: 605 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
  p.drawLine({
    start: { x: 500, y: 595 },
    end: { x: 500, y: 605 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
  p.drawText('400 +/-0.05', { x: 260, y: 615, size: 11, font: fontRegular });
  // Vertical dimension
  p.drawLine({
    start: { x: 80, y: 200 },
    end: { x: 80, y: 600 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
  p.drawLine({
    start: { x: 75, y: 200 },
    end: { x: 85, y: 200 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
  p.drawLine({
    start: { x: 75, y: 600 },
    end: { x: 85, y: 600 },
    color: rgb(0, 0, 0),
    thickness: 1,
  });
  p.drawText('400', { x: 45, y: 380, size: 11, font: fontRegular });
  // Tolerance note
  p.drawText('IT7 Grade Precision Required', {
    x: 100,
    y: 150,
    size: 14,
    font,
    color: rgb(0.8, 0.2, 0.2),
  });
}

// Page 3: Process notes
{
  const p = pdf.addPage([W, H]);
  p.drawText('Sample Drawing - Page 3 (3/3)', {
    x: 50,
    y: 780,
    size: 18,
    font,
    color: rgb(0.2, 0.3, 0.5),
  });
  p.drawText('Process Notes', {
    x: 50,
    y: 755,
    size: 12,
    font: fontRegular,
  });
  const lines = [
    '1. Rough machining: leave 0.5mm finishing allowance',
    '2. Finish machining: IT7 grade, surface roughness Ra 0.8',
    '3. QC: CMM measurement on critical dimensions',
    '4. Outsource heat treatment: HRC 58-62',
  ];
  lines.forEach((line, idx) => {
    p.drawText(line, { x: 60, y: 700 - idx * 30, size: 11, font: fontRegular });
  });
}

mkdirSync(dirname(outPath), { recursive: true });
const bytes = await pdf.save();
writeFileSync(outPath, bytes);
console.log(`OK Generated ${outPath} (${bytes.length} bytes, ${pdf.getPageCount()} pages)`);
