import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

export { pdfjs };
export { EventBus, PDFViewer, PDFLinkService, LinkTarget, RenderingStates, PDFFindController, FindState } from 'pdfjs-dist/web/pdf_viewer.mjs';
