// The parts of pdf.js (loaded from a CDN by js/pdf-reader.js as window.pdfjsLib) the board uses.

export interface PdfViewport {
  width: number;
  height: number;
}

export interface PdfPage {
  getTextContent(): Promise<{ items: { str: string }[] }>;
  getViewport(options: { scale: number }): PdfViewport;
  render(options: { canvasContext: CanvasRenderingContext2D | null; viewport: PdfViewport }): { promise: Promise<void> };
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

export interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: { data: ArrayBuffer }): { promise: Promise<PdfDocument> };
}

declare global {
  interface Window {
    pdfjsLib?: PdfJs;
  }
}
