import "photoswipe/style.css";
export { default } from "photoswipe/lightbox";

export function loadPhotoSwipeModule() {
  return import("photoswipe");
}
