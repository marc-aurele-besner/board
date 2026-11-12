// Reads a PDF in the browser with pdf.js. Text is taken when the PDF has a text layer; scanned
// pages are drawn to images so a vision model can read them.
const LIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAX_TEXT_PAGES = 60; // text is cheap, so read the whole document up to this many pages
const MAX_IMAGE_PAGES = 6; // page images are expensive; only used when there is no text layer
/** @import { PdfJs } from '../types/pdfjs' */
/** @type {Promise<PdfJs> | null} */
let loading = null;

/** @returns {Promise<PdfJs>} */
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = LIB;
    script.onload = () => {
      // The script just loaded sets it.
      /** @type {PdfJs} */ (window.pdfjsLib).GlobalWorkerOptions.workerSrc = WORKER;
      resolve(/** @type {PdfJs} */ (window.pdfjsLib));
    };
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load the PDF reader. Check your connection.'));
    };
    document.head.append(script);
  });
  return loading;
}

// Returns { text, images, pages, truncated }. `truncated` is true when some pages were not read.
/** @param {Blob} file */
export async function readPdf(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const count = Math.min(doc.numPages, MAX_TEXT_PAGES);

  let text = '';
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += `${content.items.map((item) => item.str).join(' ')}\n`;
  }
  text = text.replace(/[ \t]+/g, ' ').trim();
  if (text.length >= 40) return { text, images: [], pages: doc.numPages, truncated: doc.numPages > count };

  // Little or no text layer: draw each page so a vision model can read it.
  const imageCount = Math.min(doc.numPages, MAX_IMAGE_PAGES);
  const truncated = doc.numPages > imageCount;
  const images = [];
  for (let i = 1; i <= imageCount; i++) {
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
