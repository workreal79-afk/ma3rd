export function errorMessage(error, fallback = "حدث خطأ غير متوقع") {
  return error instanceof Error && error.message ? error.message : fallback;
}
