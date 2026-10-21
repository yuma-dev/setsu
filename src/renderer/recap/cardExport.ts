// renders the card face to a png. its own chunk: the fonts ride along as data urls because the
// svg html-to-image draws through can't load anything, and its own fetch can't read file://
import { toPng } from "html-to-image";
import geist from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline";
import geistMono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline";
import unbounded from "@fontsource-variable/unbounded/files/unbounded-latin-wght-normal.woff2?inline";

const face = (family: string, src: string) =>
  `@font-face{font-family:'${family}';font-style:normal;font-weight:100 900;src:url(${src}) format('woff2');}`;

const FONT_CSS = face("Geist Variable", geist) + face("Geist Mono Variable", geistMono) + face("Unbounded Variable", unbounded);

/** 3x the 520 x 728 face, 1560 x 2184 */
export function renderCard(node: HTMLElement): Promise<string> {
  return toPng(node, { pixelRatio: 3, fontEmbedCSS: FONT_CSS });
}
