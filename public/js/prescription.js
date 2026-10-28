// Prescription handling in the browser:
//  - text extraction: pdf.js for text PDFs, Tesseract.js OCR for images / scanned PDFs
//  - sharpness: variance of the Laplacian (low variance = blurry photo)
//  - sample generator: draws a realistic prescription for demos
const Rx = {
  async extract(file, onProgress = () => {}) {
    if (file.type === 'application/pdf') return this.fromPdf(file, onProgress);
    const img = await this.loadImage(file);
    const canvas = this.toCanvas(img, 1800);
    return { ...(await this.ocr(canvas, onProgress)), blurScore: this.blurScore(canvas), kind: 'image' };
  },

  async fromPdf(file, onProgress) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/lib/pdfjs/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = '';
    for (let p = 1; p <= Math.min(pdf.numPages, 3); p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      text += content.items.map(i => i.str).join(' ') + '\n';
    }
    onProgress(0.3, 'Read PDF text layer');
    if (text.replace(/\s/g, '').length > 30) return { text, blurScore: null, kind: 'pdf-text' };
    // Scanned PDF: render first page and OCR it
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return { ...(await this.ocr(canvas, onProgress)), blurScore: this.blurScore(canvas), kind: 'pdf-scan' };
  },

  async ocr(canvas, onProgress) {
    // Worker is served locally; the OCR engine (WASM) and English language data are fetched from the jsDelivr CDN
    const res = await Tesseract.recognize(canvas, 'eng', {
      workerPath: '/lib/tesseract/worker.min.js',
      logger: m => { if (m.status === 'recognizing text') onProgress(m.progress, 'Reading text (OCR)'); else onProgress(0.05, m.status); }
    });
    return { text: res.data.text, confidence: res.data.confidence };
  },

  loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read image'));
      img.src = URL.createObjectURL(file);
    });
  },

  toCanvas(img, maxSide) {
    const s = Math.min(1, maxSide / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  },

  // Variance of the Laplacian on an 800px grayscale copy
  blurScore(src) {
    const s = Math.min(1, 800 / Math.max(src.width, src.height));
    const w = Math.round(src.width * s), h = Math.round(src.height * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += lap; sumSq += lap * lap; n++;
      }
    }
    const mean = sum / n;
    return sumSq / n - mean * mean;
  },

  // Draw a sample prescription. quality: 'good' | 'poor'
  generateSample({ patient, medicines, quality = 'good' }) {
    const c = document.createElement('canvas');
    c.width = 1100; c.height = 1400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (quality === 'poor') ctx.filter = 'blur(3px)';
    const good = quality === 'good';
    const today = new Date();
    const date = good ? today : new Date(today.getTime() - 300 * 86400000);
    const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

    ctx.fillStyle = '#0b7a6b'; ctx.fillRect(0, 0, c.width, 14);
    ctx.fillStyle = '#111';
    ctx.font = 'bold 46px Arial'; ctx.fillText('Dr. Kavitha Subramanian', 70, 110);
    ctx.font = '30px Arial';
    ctx.fillText('MBBS, MD (General Medicine)', 70, 160);
    if (good) ctx.fillText('Reg. No: TNMC 784512', 70, 205);
    ctx.fillText('Sri Sai Clinic, 12 Main Road, Adyar, Chennai 600020', 70, 250);
    ctx.strokeStyle = '#0b7a6b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(70, 285); ctx.lineTo(1030, 285); ctx.stroke();

    ctx.font = '32px Arial';
    ctx.fillText(`Patient: ${good ? patient : 'Ravi'}`, 70, 350);
    ctx.fillText(`Date: ${fmt(date)}`, 740, 350);
    ctx.fillText('Age: 34    Sex: F', 70, 400);
    ctx.font = 'bold 64px Georgia'; ctx.fillText('Rx', 70, 500);

    ctx.font = '34px Arial';
    const meds = good ? medicines : medicines.slice(0, Math.max(0, medicines.length - 1));
    let y = 580;
    meds.forEach((m, i) => {
      ctx.fillText(`${i + 1}. ${m.name}`, 110, y);
      ctx.font = '28px Arial'; ctx.fillStyle = '#444';
      ctx.fillText('1 tablet twice daily after food x 5 days', 150, y + 42);
      ctx.font = '34px Arial'; ctx.fillStyle = '#111';
      y += 110;
    });
    if (!meds.length) { ctx.fillText('1. Rest and fluids', 110, y); y += 110; }

    ctx.font = 'italic 40px Georgia'; ctx.fillText('K. Subramanian', 700, 1250);
    ctx.font = '26px Arial'; ctx.fillText('Signature', 760, 1290);
    return new Promise(resolve => c.toBlob(b =>
      resolve(new File([b], `sample-prescription-${quality}.png`, { type: 'image/png' })), 'image/png'));
  }
};
