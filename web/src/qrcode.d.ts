declare module "qrcode" {
  interface ToDataURLOptions {
    width?: number;
    margin?: number;
    color?: { dark?: string; light?: string };
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  }
  interface ToStringOptions extends ToDataURLOptions {
    /** The handshake renders SVG so a frame can be swapped 2.5×/second with no raster cost. */
    type?: "svg" | "utf8" | "terminal";
  }
  const QRCode: {
    toDataURL(text: string, options?: ToDataURLOptions): Promise<string>;
    toString(text: string, options?: ToStringOptions): Promise<string>;
  };
  export default QRCode;
}
