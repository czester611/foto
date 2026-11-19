# Budynki Foto – wersja na iPhone (PWA)

Odpowiednik aplikacji z Androida (`app/`): ta sama logika wyszukiwania folderów na Dysku Google, panel INFO z arkusza
„Lista lokalizacji”, galeria ze zdjęciami i PDF-ami, praca offline. Działa jako strona dodana do ekranu początkowego.

## 1. Hosting (HTTPS jest wymagany)
Wgraj **zawartość katalogu `web/`** na dowolny hosting statyczny z HTTPS, np. GitHub Pages, Cloudflare Pages albo Netlify.
Adres, np. `https://twojadomena.pl/foto/`, jest potrzebny w kroku 2.

## 2. Klient OAuth w Google Cloud (jednorazowo)
1. <https://console.cloud.google.com> → projekt → **API i usługi → Biblioteka** → włącz **Google Drive API**.
2. **Ekran zgody OAuth**: typ *Wewnętrzny* (jeśli konta są w jednej organizacji Workspace) albo *Zewnętrzny* w trybie testowym
   z dodanymi kontami testowymi. Zakres: `.../auth/drive.readonly`.
3. **Dane logowania → Utwórz → Identyfikator klienta OAuth → Aplikacja internetowa**.
   - *Autoryzowane źródła JavaScript*: `https://twojadomena.pl`
   - *Autoryzowane URI przekierowania*: **dokładnie** adres aplikacji, np. `https://twojadomena.pl/foto/`
     (ze znakiem `/` na końcu, jeśli tak jest w adresie).
4. Skopiuj Client ID do `config.js` (`CLIENT_ID`).

> Klient OAuth z Androida (`pl.syreny.foto` + SHA-1) **nie** zadziała w przeglądarce – potrzebny jest osobny, typu „Aplikacja internetowa”.

## 3. Instalacja na iPhonie
Safari → otwórz adres → **Udostępnij → Dodaj do ekranu początkowego**. Uruchamiaj z ikony (tryb pełnoekranowy).
Wymagane iOS 16.4 lub nowszy (zalecane).

## Różnice względem Androida
- **Aktualizacje**: automatyczne – po wgraniu nowych plików aplikacja pobiera je przy następnym uruchomieniu z internetem.
  Przy zmianie plików podbij `V` w `sw.js`.
- **Logowanie**: token Google ważny ok. 1 godziny; po wygaśnięciu aplikacja przekierowuje do Google i wraca z tym samym numerem
  budynku. Offline pokazuje zapamiętane budynki bez logowania.
- **Nawigacja**: przycisk z adresem otwiera Apple Maps (tryb jazdy).
- **Cache offline**: IndexedDB (zdjęcia 1600 px + miniatury, 7 dni, limit 1,5 GB). iOS może wyczyścić dane strony, której nie
  używano ok. tygodnia – uruchamiaj aplikację z ikony ekranu początkowego, wtedy limit nie dotyczy.
- Nie ma `mapping.json` (w Androidzie nie był używany w kodzie).

## Testy lokalne
`python3 -m http.server 8000` w katalogu `web/` → `http://localhost:8000/` (localhost jest traktowany jako bezpieczny kontekst;
dodaj ten adres do źródeł i URI przekierowania w kliencie OAuth na czas testów).
