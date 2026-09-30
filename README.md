# OGameX Assistant

Asystent do OGameX w formie skryptu Tampermonkey. Jego główne zadanie to ochrona floty:
wykrywa nadlatujące ataki, sam wyprowadza flotę spod uderzenia i sprowadza ją z powrotem,
gdy zagrożenie minie. Dodatkowo automatyzuje Fleet Save, ekspedycje, mining asteroid,
zbieranie złomu i farmienie nieaktywnych graczy.

Skrypt działa na serwerach **athena.ogamex.net** oraz **genesis.ogamex.net**. Ustawienia
i stan są przechowywane osobno dla każdego serwera.

> Bot działa wyłącznie wtedy, gdy karta z grą jest otwarta w przeglądarce.

---

## Spis treści

1. [Instalacja](#1-instalacja)
2. [Powiadomienia na telefon](#2-powiadomienia-na-telefon)
3. [Obrona floty](#3-obrona-floty)
4. [Ekspedycje](#4-ekspedycje)
5. [Fleet Save](#5-fleet-save)
6. [Ekonomia](#6-ekonomia)
7. [Farma nieaktywnych](#7-farma-nieaktywnych)
8. [Panel](#8-panel)
9. [Dobre praktyki](#9-dobre-praktyki)
10. [Rozwiązywanie problemów](#10-rozwiązywanie-problemów)

---

## 1. Instalacja

1. Zainstaluj w przeglądarce Chrome rozszerzenie **Tampermonkey** z Chrome Web Store.
2. Otwórz `chrome://extensions`, kliknij **Szczegóły** przy Tampermonkey i włącz opcję
   **Zezwalaj na skrypty użytkownika**. Bez tego skrypt nie zostanie uruchomiony.
3. Otwórz link instalacyjny i kliknij **Zainstaluj**:

   **https://raw.githubusercontent.com/Mitjano/ogamex-assistant/main/ogamex-assistant.user.js**

4. Wejdź do gry. W rogu strony pojawi się panel **OGameX 3**.

Skrypt aktualizuje się automatycznie. Aktualizację można wymusić w Tampermonkey:
**Panel → Zainstalowane skrypty → Sprawdź aktualizacje**.

## 2. Powiadomienia na telefon

Alarmy o atakach przychodzą przez darmową usługę [ntfy.sh](https://ntfy.sh).

1. Zainstaluj na telefonie aplikację **ntfy** (Android / iOS).
2. W panelu bota rozwiń sekcję **Ustawienia: Obrona**. Na dole znajduje się linia
   `ntfy: ogx-…`. To Twój prywatny temat, wylosowany przy instalacji.
3. W aplikacji ntfy dodaj subskrypcję **dokładnie tego tematu** (serwer domyślny ntfy.sh).
4. Kliknij w panelu **Test push**. Powiadomienie powinno przyjść na telefon.

Tematu nie udostępniaj innym osobom: kto go zna, widzi Twoje alarmy.
Na iPhonie tryb cichy wycisza powiadomienia, dlatego dzwonki muszą być włączone.

## 3. Obrona floty

Po instalacji bot pracuje w trybie **Obserwator**: wykrywa zagrożenia i alarmuje,
ale nie rusza floty. Aby włączyć automatyczną obronę:

1. W sekcji **Ustawienia: Obrona** kliknij przycisk, tak aby pokazywał **Auto-ratunek ON**.
2. Ustaw **Rezerwę deuteru**, czyli ilość deuteru, która zawsze zostaje na ciele
   przy każdym locie (0 oznacza brak rezerwy).
3. **Prędkość ucieczki** pozostaw na 3%. Wolny lot sprawia, że flota wisi w powietrzu
   w chwili uderzenia i może zostać zawrócona.

Jak działa obrona:

- Bot odczytuje listę ruchów flot i pasek misji, rozpoznaje ataki (ATTACK, ACS, DESTROY)
  i odróżnia je od sond szpiegowskich, które nie powodują ruchu floty.
- Flota z atakowanego ciała leci misją **Stacjonuj** na sąsiedni księżyc albo inną
  bezpieczną kolonię. Po odwołaniu lub przejściu ataku bot sam klika zawrót.
- Każda fala, która wyląduje na atakowanym ciele przed uderzeniem (np. powrót z ekspedycji),
  otrzymuje osobny lot ratunkowy.
- Po zniszczeniu księżyca bot stawia nowy za metal, a floty lądujące w tym czasie
  na planecie wywozi w bezpieczne miejsce, po odbudowie na nowy księżyc.
- **Zegar dolotu** pokazuje godzinę uderzenia i moment wysłania recyklerów po bitwie.

Działanie obrony można sprawdzić bez ryzyka: w sekcji **Narzędzia i testy** znajdują się
przyciski **TEST: atak na księżyc** oraz **TEST: atak na planetę**.

## 4. Ekspedycje

Sekcja **Ustawienia: Ekspedycje**:

| Pole | Znaczenie |
|---|---|
| **startuj z** | Koordynaty ciała, z którego startuje flota (`g:s:p`). Jeśli para ma księżyc, bot startuje z księżyca. Bez tego pola fale startują z aktualnie wybranej planety. |
| **fale** | Na ile równych fal bot dzieli flotę. Zazwyczaj tyle, ile masz slotów ekspedycji. |
| **rezerwa slotów** | Liczba slotów floty, które zawsze pozostają wolne dla ratunku. |
| **Odkrywca 40 min** | Tylko dla klasy Odkrywca. Przy innych klasach ekspedycje trwają 1 h. |

Po ustawieniu pól kliknij **Ekspedycje ON**.

## 5. Fleet Save

Fleet Save trzyma flotę w powietrzu, np. na noc, i sprowadza ją o wybranej godzinie.

| Pole | Znaczenie |
|---|---|
| **wróć o** | Godzina, o której flota ma być z powrotem w domu, np. `08:30`. |
| **cel (księżyc)** | Księżyc **innej** pary niż ta, na której stoi flota, najlepiej odległy. Puste pole: bot wybierze najdalszą kolonię z księżycem. |
| **prędkość** | Zalecane 3%: im wolniej, tym dłużej flota pozostaje w powietrzu. |
| **po powrocie w domu … h** | Ile godzin po powrocie flota pracuje na ekspedycjach, zanim ponownie poleci na Fleet Save. Przykład: powrót 08:30 i 16 h oznacza start Fleet Save około 00:30. |

Po ustawieniu kliknij **FS ON**.

Fleet Save startuje wyłącznie z księżyca (planety są widoczne dla falangi). Bot odczytuje
czas lotu z formularza gry i zawraca flotę w połowie drogi, tak aby wylądowała o ustawionej
godzinie. Fale ekspedycji, które wrócą w trakcie Fleet Save, otrzymują własne loty
i wracają razem z resztą floty.

## 6. Ekonomia

Sekcja **Ustawienia: Ekonomia**:

- **Mining**: wyszukuje asteroidy na pozycji 17 i wysyła minery. Pole **minery na lot**
  ustala dokładną liczbę minerów na jeden lot. Puste pole oznacza, że bot dobiera ją sam.
- **Złom**: zbiera recyklerami pole zniszczeń na pozycji 16 układu startowego ekspedycji.
- **Bonus**: odbiera bonus online.
- **Księżyce**: stawia księżyc za metal, gdy para go nie ma, do ustawionego limitu % metalu.
- **Cisza nocna** i **Przerwy kawowe**: opcjonalny kamuflaż. W tych oknach ekonomia
  się wstrzymuje, obrona działa zawsze.
- **gdy klikasz: fala czeka … min**: jak długo ekonomia czeka po Twoim kliknięciu.
  0 oznacza, że fale lecą od razu.

## 7. Farma nieaktywnych

Sekcja **Ustawienia: Farma**:

| Pole | Znaczenie |
|---|---|
| **statek** | OW (okręt wojenny), DT (duży transporter) albo MT (mały transporter). |
| **sztuk na atak** | Liczba statków w jednym ataku. |
| **start z** | Koordynaty ciała, z którego startują ataki. Zalecany inny księżyc niż baza ekspedycji. |
| **zakresy** | Układy do przeszukania, np. `2:1-499` albo `3:100-200, 3:250-300`. |
| **rank ≤** | Atakowani są tylko nieaktywni gracze z rankingiem nie wyższym niż podana wartość. 0 wyłącza filtr. |
| **min. łup** | Pomija cele, których średni łup jest niższy od progu. |

Po ustawieniu kliknij **Farma ON**.

Bot przegląda galaktykę układ po układzie, atakuje graczy oznaczonych `(i)` lub `(I)`
i pomija urlopy oraz graczy chronionych. Planety, na których flota poniosła straty,
trafiają na czarną listę na 14 dni. Farma zawsze pozostawia wolne sloty dla ratunku
i zatrzymuje się, gdy konto jest atakowane.

## 8. Panel

- Panel można przeciągać za nagłówek i zwijać przyciskiem `_`.
- Pasek na górze pokazuje stan modułów: Obrona, Flota, Ekspedycje, Powroty, Mining, Fleet Save.
- **RATUJ FLOTĘ TERAZ** wysyła flotę w bezpieczne miejsce ręcznie.
  **WRÓĆ NA BAZĘ** sprowadza ją z powrotem.
- **Dziennik obrony** zawiera historię ataków, ratunków i zawrotów.
  **Log** zawiera pełny zapis działań bota.
- Przycisk **ON/OFF** w nagłówku włącza i wyłącza całego bota.

## 9. Dobre praktyki

- Karta z grą musi pozostać otwarta, najlepiej widoczna.
- W Chrome: **Ustawienia → Wydajność** — dodaj `ogamex.net` do witryn zawsze aktywnych,
  aby przeglądarka nie usypiała karty.
- Nie usypiaj komputera, gdy bot ma pilnować floty.
- Otwórz grę w jednej karcie. Przy kilku kartach bota prowadzi tylko jedna,
  pozostałe czekają w trybie pasywnym.
- Gdy klikasz po grze, bot ustępuje i nie przejmuje karty.
- Ustawienia są zapisane w danej przeglądarce. Na innym komputerze trzeba je wprowadzić ponownie.

## 10. Rozwiązywanie problemów

| Objaw | Rozwiązanie |
|---|---|
| Panel się nie pojawia | Sprawdź, czy w `chrome://extensions` przy Tampermonkey włączone jest **Zezwalaj na skrypty użytkownika**, i odśwież grę. |
| Karta lub rozszerzenie przestały działać | Zamknij i uruchom ponownie Chrome. **Nie reinstaluj Tampermonkey** — reinstalacja kasuje wszystkie ustawienia bota. |
| Nie przychodzą powiadomienia | Porównaj temat w aplikacji ntfy z linią `ntfy:` w panelu i użyj przycisku **Test push**. |
| Bot nie rusza floty przy ataku | Sprawdź, czy włączony jest **Auto-ratunek ON**. W trybie Obserwator bot tylko alarmuje. |
| Fleet Save nie startuje | Cel musi być księżycem innej pary, a flota musi stać na księżycu. Powód jest opisany w logu. |
| Inny problem | W sekcji **Log** kliknij **Kopiuj** i przekaż treść logu. |

---

Aktualną wersję skryptu pokazuje nagłówek panelu. Zgłoszenia problemów: zakładka
[Issues](https://github.com/Mitjano/ogamex-assistant/issues).
