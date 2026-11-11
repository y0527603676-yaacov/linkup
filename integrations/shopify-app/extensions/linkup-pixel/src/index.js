import { register } from "@shopify/web-pixels-extension";
import { createPixel } from "./logic.js";

register((api) => createPixel(api));
