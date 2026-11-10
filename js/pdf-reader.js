// Reads a PDF in the browser with pdf.js. Text is taken when the PDF has a text layer; scanned
// pages are drawn to images so a vision model can read them.
const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAX_PAGES = 6;
let loading = null;

function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIB;
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
      resolve(window.pdfjsLib);
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the PDF reader. Check your connection.'));
    };
    document.head.append(script);
  });
  return loading;
}

// Returns { text, images, pages, truncated }. Only the first MAX_PAGES pages are read.
export async function readPdf(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const count = Math.min(doc.numPages, MAX_PAGES);
  const truncated = doc.numPages > count;

  let text = '';
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += `${content.items.map((item) => item.str).join(' ')}\n`;
  }
  text = text.replace(/[ \t]+/g, ' ').trim();
  if (text.length >= 40) return { text, images: [], pages: doc.numPages, truncated };

  // Little or no text layer: draw each page so a vision model can read it.
  const images = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.85));
  }
  return { text: '', images, pages: doc.numPages, truncated };
}
