# Oracle keşfi — Aşama 0 kapısı

**Durum:** Ölçüm kaydı. Uygulanmış özellik beyanı değildir.
**Tarih:** 20 Eylül 2026. **Kapsam:** Stellar Testnet.
**Bağlam:** `STOP_LOSS_DESIGN_TR.md` §5 ve §14 Aşama 0.

Bu dosya, stop kontratı yazılmadan önce doldurulması şart koşulan oracle
kanıtlarını taşır. Her satır canlı zincirden okundu; hiçbiri belgeden veya
frontend sabitinden alınmadı.

## 1. Ağ ve kontrat kimliği

| Alan | Değer |
| --- | --- |
| Ağ | Stellar Testnet |
| Passphrase | `Test SDF Network ; September 2015` |
| RPC | `https://soroban-testnet.stellar.org` |
| Oracle kontratı | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Oracle WASM SHA-256 | `8ecd1857496df2c15aaab4d18d2d7689542a62814245e9b2c613c609b86bd11c` |
| `version()` | `6` |
| Sağlayıcı | Reflector (SEP-40 tüketici arayüzü) |

**Sağlayıcı kaynağı doğrulanmadı.** Bu feed'in hangi piyasalardan veri aldığını
zincirden kanıtlayamam; yalnızca yayımlanan değerleri okuyabiliyorum. Reflector
belgeleri kaynak iddiasında bulunur, bu dosya o iddiayı doğrulamış saymaz.

## 2. Feed yapılandırması (zincirden)

| Çağrı | Değer | Not |
| --- | --- | --- |
| `base()` | `Other("USD")` | Baz **USD**, USDC değil |
| `decimals()` | `14` | Fiyatlar `10^14` ile ölçekli tam sayı |
| `resolution()` | `300` | Nominal yayın periyodu, saniye |
| `history_retention_period()` | `86400` | 24 saat geçmiş |
| `cache_size()` | `2` | |
| `admin()` | `GBUVCM6X…VBMZ5HQI` | **Canlı admin var** |
| `assets()` | 16 varlık, hepsi `Other(Symbol)`: BTC, ETH, USDT, XRP, SOL, **USDC**, ADA, AVAX, DOT, MATIC, LINK, DAI, ATOM, **XLM**, UNI, EURC | **TRY yok** |

### 2.1 Varlık kimliği biçimi

Yalnız `Other(Symbol)` biçimi yanıt veriyor. Denenen ve **null dönen** biçimler:

- `Other("XLMUSDC")` → `null` (doğrudan çift feed'i yok)
- `Stellar(USDC SAC)` → `null`
- `Stellar(XLM SAC)` → `null`

`twap(asset, records)` bu dağıtımda **mevcut değil** — çağrı
`HostError: Error(WasmVm, MissingValue)` ile düşüyor. Tasarımın §5 TWAP
maddesi bu nedenle uygulanamaz: wick koruması iddia edilemez.

### 2.2 Yükseltilebilirlik — kayda geçen risk

Kontratta `update_contract(wasm_hash)` girişi ve dolu bir `admin` var. Yani
**oracle'ın davranışı, bizim V3 adresimiz sabit olsa bile, üçüncü bir tarafça
değiştirilebilir.** Tasarımın "sabit vault adresleri dış bağımlılıkların
yönetim yetkisini ortadan kaldırmaz" uyarısının somut karşılığı budur. Risk
envanterine böyle girer; azaltılmış sayılmaz.

## 3. Tetik birimi kararı

Tasarım §5 üç kademeli merdiven tanımlıyor:

1. **Doğrudan XLM/USDC feed'i** → **yok** (§2.1'de kanıtlandı).
2. **Doğrulanmış XLM/USD ve USDC/USD'den çapraz kur** → **mümkün.** İkisi de
   `assets()` içinde ve ikisi de değer döndürüyor.
3. USDC/USD yoksa sessizce 1 kabul etme → **bu kademeye düşülmedi.**

Seçilen birim: **USDC/XLM, iki USD feed'inden çaprazlama.**

```
USDC_per_XLM = XLM_USD * 10^14 / USDC_USD        (tam sayı, geniş aritmetik)
```

USDC/USD ölçülen değeri **1.00021111524964** — yani tam 1 değil. Sessizce 1
kabul etmek %0.02'lik sistematik bir sapma üretirdi; çaprazlama bunu kapatıyor.

## 4. Canlı örnek (20 Eylül 2026)

Ledger 4 773 245, duvar saati `1789889816`:

| Alan | Ham | Ölçekli |
| --- | --- | --- |
| XLM/USD | `19049712370749` | 0.19049712370749 USD |
| USDC/USD | `100021111524964` | 1.00021111524964 USD |
| Her ikisinin `timestamp` | `1789889700` | yaş **116 s** |
| İki feed arası zaman damgası farkı | `0` | aynı yayın turunda |
| Çapraz USDC/XLM | `19045691534826` | **0.19045691534826 USDC/XLM** |

Her iki varlık aynı `timestamp` ile yayımlanıyor; bu, çapraz kurun iki farklı
ana ait iki fiyatı karıştırması riskini bu feed'de düşürüyor. Yine de kontrat
tarafında zaman damgası eşitliği/yakınlığı **kontrol edilmeli**, gözleme
güvenilmemeli.

## 5. Oracle fiyatı ile AMM fiyatı arasındaki fark — kapı bulgusu

Aynı anda ölçülen Soroswap testnet kotasyonu:

| Kaynak | USDC/XLM |
| --- | --- |
| Reflector çaprazı (gerçek dünya) | **0.1904569** |
| Soroswap testnet havuzu (10 XLM için) | **0.1053587** |
| **Oran** | **1.81×** |
| **Fark** | **+80.8 %** |

Testnet havuzu gerçek fiyata arbitrajlanmıyor; sentetik bir havuz. Bunun
stop-loss için doğrudan sonucu şudur:

- Oracle 0.19 civarındayken kullanıcı 0.19'a stop koyarsa tetik **anında**
  geçerli olur, ama AMM yalnız ~0.105 verir. Net minimum tetik fiyatına yakın
  ayarlanmışsa satış **hiç gerçekleşmez** — `SlippageExceeded` ile döner.
- Testnet'te gerçekten dolan bir stop göstermek için tetik fiyatı ile
  `min_user_out` arasında **~%45'lik** bir açıklık bırakmak gerekir. Bu, ürünün
  minimum garantisini gösteren dürüst bir gösterim **değildir**; yalnızca
  mekanizmanın çalıştığını gösterir.

**Bu, Aşama 1'i (kontrat yazımı) engellemez** — kontratın matematiği fiyat
kaynağından bağımsız olarak doğrudur. **Aşama 3'ü (canlı stop kanıtı)
doğrudan etkiler** ve o kanıtın nasıl sunulacağı şimdiden karara bağlanmalıdır:
iki fiyatın ayrıştığı açıkça yazılmadan canlı bir stop dolumu sunulamaz.

## 6. `OraclePolicy` — ölçülmüş değerlerle öneri

| Parametre | Önerilen | Gerekçe / durum |
| --- | --- | --- |
| `source` | `CCYOZJCO…MJRN63` | §1'de doğrulandı |
| `assets` | `Other("XLM")`, `Other("USDC")` | §2.1'de doğrulandı; başka biçim çalışmıyor |
| `base` | `Other("USD")` | Zincirden okundu |
| `scale` | `10^14` | `decimals()` = 14 |
| `mode` | **spot** | `twap` bu dağıtımda yok |
| `max_age_secs` | **900** | §6.1'de ölçüldü: yayın aralığı 300 s, en kötü gözlenen zincire yansıma gecikmesi 141 s. 600 + 141 = 741 < 900, yani **tam bir kaçan yayını** tolere eder ve durmuş bir feed'i yine reddeder |
| `max_skew_secs` | **60** | Gözlenen bacak farkı üç turda da 0 s. 60 s marj bırakır ama iki farklı turdan (300 s arayla) fiyat çaprazlamayı engeller |
| `max_future_skew_secs` | **0** | Tasarım §5: ilk sürümde gelecek toleransı yok |
| `policy_version` | `1` | |

### 6.1 Yayın kadansı ölçümü

30 saniyede bir örnekleme, ~13 dakikalık pencere, üç farklı yayın gözlendi:

| Feed `timestamp` | Zincirde görüldüğü an | Yayın aralığı | Gecikme | Bacak ts farkı |
| --- | --- | --- | --- | --- |
| `1789889700` | `1789889841` | — | 141 s | 0 |
| `1789890000` | `1789890056` | 300 s | 56 s | 0 |
| `1789890300` | `1789890334` | 300 s | 34 s | 0 |

- Yayın aralığı iki ölçümde de **tam 300 s** — `resolution()` ile uyumlu.
- Zincire yansıma gecikmesi **34–141 s** arasında değişiyor; sabit değil.
- XLM ve USDC **her turda aynı `timestamp` ile** yayımlanıyor.

**Örneklem sınırı:** 13 dakika ve üç yayın. Günün farklı saatlerinde veya
sağlayıcı olayları sırasında gecikmenin 141 s'yi aşmayacağı **kanıtlanmadı**.
`max_age_secs = 900` bu sınırı bilerek geniş seçilmiştir; daha dar bir değer
daha uzun bir ölçüm penceresi gerektirir.

## 7. Kapı durumu

| Eksen | Durum |
| --- | --- |
| Oracle adresi, WASM, sürüm kaydedildi | ✅ |
| `base`/`decimals`/`resolution`/`assets` zincirden okundu | ✅ |
| Varlık kimliği biçimi belirlendi | ✅ `Other(Symbol)` |
| Tetik birimi kararı (§5 merdiveni) | ✅ çapraz USDC/XLM, 2. kademe |
| USDC/USD sessizce 1 kabul edilmedi | ✅ |
| `lastprice` örnekleri ve zaman damgaları | ✅ |
| TWAP semantiği | ⛔ yok — TWAP iddiası yasak |
| Sağlayıcı veri kaynağı doğrulaması | ⛔ **yapılamadı** |
| Oracle yükseltilebilirliği | ⚠️ admin + `update_contract` var, risk kaydedildi |
| `max_age_secs` / skew ölçümü | ✅ ölçüldü (§6.1), örneklem penceresi 13 dk |
| Oracle ↔ AMM fiyat ayrışması | ⚠️ **%80.8** — Aşama 3 sunumunu kısıtlar |

**Sonuç:** Oracle teknik kapısı **geçti**. Tetik birimi, şema, yaş ve skew
sınırları ölçümle dolduruldu. Açık kalan tek madde **Aşama 3'ün sunum kararı**:
oracle ile AMM arasındaki %80.8'lik ayrışma nedeniyle canlı bir stop dolumu,
tetik fiyatı ile net minimum arasında geniş bir açıklık gerektirir ve bu
açıklık kanıtla birlikte yazılmadan sunulamaz.
