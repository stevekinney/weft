export function weftUi() {
  return new Response('<main>fixture console</main>', {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
