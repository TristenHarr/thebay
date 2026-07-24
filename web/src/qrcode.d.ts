declare module "qrcode" {
  interface ToDataURLOptions {
    width?: number;
    margin?: number;
    color?: { dark?: string; light?: string };
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  const QRCode: {
    toDataURL(text: string, options?: ToDataURLOptions): Promise<string>;
  };
  export default QRCode;
}
