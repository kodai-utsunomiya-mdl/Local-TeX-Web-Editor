let loading;

// Both PDF previews share one runtime. The home screen and text editors can
// become usable before the browser downloads and evaluates the PDF library.
export function loadPDFRuntime() {
  if (!loading) loading = import('./pdf-runtime.js').catch(error => { loading = null; throw error; });
  return loading;
}
