declare module "pdf-parse" {
  interface PDFInfo {
    numpages?: number;
    numrender?: number;
    info?: any;
    metadata?: any;
    version?: string;
  }

  interface PDFData {
    numpages: number;
    numrender: number;
    info: any;
    metadata: any;
    version: string;
    text: string;
  }

  interface Options {
    pagerender?: (pageData: any) => Promise<string>;
    max?: number;
    version?: string;
  }

  function pdf(data: Buffer | Uint8Array, options?: Options): Promise<PDFData>;

  export = pdf;
}
