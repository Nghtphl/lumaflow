# V3 stop vault — deploy manifesti

**Durum:** Deploy öncesi hazırlık. **Hiçbir şey zincire gönderilmedi.**
**Tarih:** 20 Eylül 2026. **Kapsam:** Stellar Testnet.
**Bağlam:** `STOP_LOSS_DESIGN_TR.md` Aşama 3, `ORACLE_DISCOVERY_TR.md` §6.

Bu dosya, V3'ün hangi parametrelerle deploy edileceğini ve bunların hangisinin
canlı zincirden okunduğunu kaydeder. Onay alınmadan hiçbir işlem gönderilmez.

## 1. Ağ ve imzalayan

| Alan | Değer | Kaynak |
| --- | --- | --- |
| Ağ | Stellar Testnet | — |
| Passphrase | `Test SDF Network ; September 2015` | — |
| RPC | `https://soroban-testnet.stellar.org` | — |
| İmzalayan | `deployer` → `GBICM7WA…N6OI6A` | `stellar keys address deployer` |
| Yetki kanıtı | **V2'yi bu hesap deploy etti** | Zincirdeki V2 WASM'i `d9ad61c2…142c`; bu hesabın 20 Eyl 05:22'de yüklediği executable ile aynı |
| XLM bakiyesi | 9 917.0175586 | Horizon, 20 Eyl 11:04 |
| USDC bakiyesi | 1.0535743 (trustline **var**) | Horizon, 20 Eyl 11:04 |

İmzalayan hesap keeper'ın salt-okunur kaynak hesabıyla aynıdır; bu yalnız
simülasyon içindir, keeper'ın imza yetkisi yoktur.

Runbook `trigger-deployer` adını kullanıyor; yerel keystore'da böyle bir kimlik
**yok**, gerçek kimliğin adı `deployer`. Konsoldaki emirlerin sahibi olan
cüzdanlar (`GAJGMHHG…`, `GCT6ODOI…`) bu hesaptan farklıdır — bu bir dağıtım
hesabıdır, kullanıcının Freighter cüzdanı değil.

## 2. WASM

| Alan | Değer |
| --- | --- |
| Yol | `contracts/stop_vault/target/wasm32-unknown-unknown/release/trigger_stop_vault.wasm` |
| Boyut | 24 981 bayt |
| SHA-256 | `4ced7ccf3aec9f4cd9f64c3c0766f23c76a765fb22410cae7727a1f4eb4377d8` |
| Derleme | `cargo build --release --target wasm32-unknown-unknown` |

Bu hash, önceki oturumun bildirdiği hash ile **birebir aynı** — kaynak
değişmemiş.

**Optimize uyarısı.** `stellar contract upload` ve `deploy`, `--optimize`
varsayılanı `true` ile çalışır ve zincire **farklı** bir artefakt yükler:
22 696 bayt, SHA-256 `92722aeeeafe5ae3061abcf0eac68e9f52191923916a8d6d7a15b1e715101435`.
**Karar: `--optimize=false`.** Zincirdeki hash, CLAUDE.md'deki
`cargo build --release --target wasm32-unknown-unknown` komutuyla birebir
yeniden üretilebilir kalır. 2,3 KB'lik ücret farkı, doğrulanabilirlik
karşısında ucuzdur.

## 3. Constructor parametreleri

ABI (`stellar contract info interface --wasm …`) ile doğrulandı:

```
__constructor(router: Address, policy: OraclePolicy,
              collateral_token: Address, payout_token: Address,
              max_amount_in: i128) -> Result<(), Error>
```

### 3.1 Router

| Alan | Değer | Doğrulama |
| --- | --- | --- |
| `router` | `CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD` | Canlı: `router_pair_for(XLM, USDC)` → `CCBX3NZTCQLQFSPG7HBOKL4P2RVPOPVFHDNRTOSCCJWBTPL2GHEH7RQS` |

### 3.2 Oracle politikası

Tümü 20 Eylül 11:04'te canlı kontrattan **yeniden** okundu:

| Alan | Değer | Zincir okuması |
| --- | --- | --- |
| `source` | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` | — |
| `base` | `Other("USD")` | `base()` → `{"Other":"USD"}` ✅ |
| `asset` | `Other("XLM")` | `lastprice` yanıt veriyor ✅ |
| `quote` | `Other("USDC")` | `lastprice` yanıt veriyor ✅ |
| `decimals` | `14` | `decimals()` → `14` ✅ |
| `max_age_secs` | `900` | **Ölçüme dayalı tercih, doğrulanmış güvenlik sınırı değil** |
| `max_skew_secs` | `60` | Gözlenen bacak farkı 0 s |
| `max_future_secs` | `0` | Tasarım §5 |
| `version` | `1` | — |

`max_age_secs = 900` değeri 13 dakikalık, üç yayınlık bir örnekleme
penceresinden çıkarıldı (`ORACLE_DISCOVERY_TR.md` §6.1). `resolution()` = 300 s
olduğu için 900 s, kaçan **tam bir yayını** tolere eder ve durmuş bir feed'i
yine reddeder. Testnet için makul; üretim için yeniden ölçülmelidir.

### 3.3 Token çifti ve boyut sınırı

| Alan | Değer |
| --- | --- |
| `collateral_token` (satılan) | XLM SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| `payout_token` (alınan) | USDC SAC `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| `max_amount_in` | **karar: 100 000 000 stroop = 10.0000000 XLM** |

`max_amount_in` kontratta **kalıcı olarak sabittir**; setter yoktur. Sınır
**emir başınadır**, toplam değil: 3 XLM'lik iki test emri ayrı ayrı sığar.
10 XLM, bir hata durumunda tek bir emirde zincirde kilitlenebilecek teminatı
sınırlar ve bu dağıtımın bir test dağıtımı olduğunu kendi parametresiyle
söyler. Daha büyük emir gerekirse yeni bir dağıtım gerekir — bu, sınırın
amacıdır, eksikliği değil.

## 4. Canlı fiyat okumaları (20 Eylül 11:04)

### 4.1 Oracle

| Bacak | Ham | Ölçekli | `timestamp` | Yaş |
| --- | --- | --- | --- | --- |
| XLM/USD | `18985526931679` | 0.18985526931679 | 1789891200 | 294 s |
| USDC/USD | `100001336977972` | 1.00001336977972 | 1789891200 | 294 s |
| **Çapraz USDC/XLM** | `18985273102759` | **0.18985273102759** | — | bacak farkı **0 s** |

### 4.2 AMM (Soroswap testnet havuzu)

| Giriş | Çıkış | Birim fiyat |
| --- | --- | --- |
| 10.0000000 XLM | 1.0535869 USDC | 0.10535869 USDC/XLM |
| 3.0000000 XLM | 0.3160766 USDC | 0.10535886 USDC/XLM |

### 4.3 İki fiyat ayrışması — kayda geçer

| Kaynak | USDC/XLM |
| --- | --- |
| Oracle (gerçek dünya) | 0.1898527 |
| AMM (testnet havuzu) | 0.1053589 |
| **Oran** | **1.802×** — AMM oracle'ın %55,5'i |

Testnet havuzu arbitrajlanmıyor. Bu, **tetik fiyatı** ile **dolum fiyatı**nın
aynı sayı olmadığı anlamına gelir ve her canlı gösterimde ayrı ayrı
yazılmalıdır. Bir stop'un tetiklenmesi, havuzun o fiyattan alacağı anlamına
gelmez.

## 5. Önerilen test emirleri

İkisi de **yeni ve küçük** emirlerdir; mevcut V0/V1/V2 emirlerine dokunulmaz.

### Emir A — mekanizmanın dolumu

| Alan | Değer | Ham |
| --- | --- | --- |
| Teminat | 3.0000000 XLM | `30000000` |
| Tetik (`stop_price`) | 0.1895 USDC/XLM | `18950000000000` |
| Net minimum (`min_user_out`) | 0.3000000 USDC | `3000000` |
| Keeper ödülü (`fee_bps`) | 100 (%1) | `100` |
| Süre | 24 saat | — |

Hesap: router'a sorulan brüt taban `ceil(3 000 000 × 10 000 / 9 900)` =
`3 030 304` stroop. Havuz şu an `3 160 766` veriyor → **%4,1 pay** var.
Dolarsa keeper'a ≈0.0031607 USDC, kullanıcıya ≈0.3129159 USDC gider.

Bu emrin net minimumu (0.10 USDC/XLM efektif taban) tetik seviyesinin
(0.1895) çok altındadır. **Bu, ürünün koruma vaadinin gösterimi değildir**;
testnet havuzunun gerçek fiyattan %45 sapmasının sonucudur. Kullanıcı bu
zayıf tabanı bilerek kabul eder.

### Emir B — dürüst ret

| Alan | Değer | Ham |
| --- | --- | --- |
| Teminat | 3.0000000 XLM | `30000000` |
| Tetik | 0.1895 USDC/XLM | `18950000000000` |
| Net minimum | 0.5500000 USDC | `5500000` |
| Keeper ödülü | 100 (%1) | `100` |

Brüt taban `5 555 556` stroop; havuz `3 160 766` veriyor. `execute_stop`
router'ın kendi `amount_out_min` kapısında geri döner, emir `Triggered`
kalır, teminat sahibinindir. Tasarımın "tetiklenmek satılmak değildir"
iddiasının canlı kanıtı budur ve **başarısızlık değil, doğru davranıştır**.

### 5.1 Tetik gerçekçiliği — garanti verilmiyor

Oracle şu an 0.1898527. Önerilen 0.1895 tetik, **%0,19 aşağıda**. Feed 300
saniyede bir yayın yapıyor. Bu düşüşün gösterim penceresinde gerçekleşip
gerçekleşmeyeceği piyasaya bağlıdır.

Düşüş gelmezse emir `Armed` kalır ve rapor **"tetik bekleniyor"** olarak
yazılır. Oracle taklit edilmez, kontrat kapısı gevşetilmez, tetik seviyesi
"geçsin diye" piyasanın üstüne çekilmez.

## 6. İşlem planı ve ücretler

| # | İşlem | Kim imzalar | Not |
| --- | --- | --- | --- |
| 1 | `stellar contract upload --wasm … --optimize=false` | deployer | WASM'i kurar, hash döner |
| 2 | `stellar contract deploy --wasm-hash <hash> -- <ctor>` | deployer | Kontratı yaratır **ve** constructor'ı aynı işlemde çalıştırır (Protokol 22+ `CreateContractV2`) |

**Deploy = 2 işlem.** `stellar contract deploy --wasm` tek komutta ikisini de
yapar; burada ayrıştırılması, zincire giden hash'in okunup kaydedilebilmesi
içindir. İşlem sayısı komutun kendi çıktısından teyit edilecek, bu tablodan
varsayılmayacak.

**Ücretler — ÖLÇÜLDÜ, tahmin değil.** Yükleme işlemi RPC'ye `simulateTransaction`
ile gönderilmeden simüle edildi:

| Kalem | Ölçüm | Kaynak |
| --- | --- | --- |
| V3 yükleme (24 981 bayt, optimize kapalı) | **4.0044925 XLM** | `minResourceFee` simülasyonu |
| V3 yükleme (22 696 bayt, optimize açık) | 3.8281702 XLM | `minResourceFee` simülasyonu |
| V3 deploy + constructor | ölçülemedi — WASM yüklenmeden simüle edilemiyor | — |
| V2 yükleme (11 250 bayt) | 2.0460526 XLM | Horizon, **gerçekten ödenmiş** |
| V2 deploy + constructor | 0.0033409 XLM | Horizon, **gerçekten ödenmiş** |

V3'ün WASM'i V2'nin 2,22 katı (24 981 / 11 250) ve ücreti de 1,96 katı çıkıyor —
yani rakam simülasyon tuhaflığı değil, boyutun doğrudan sonucu. Deploy ayağı
V2'de 0,0033 XLM'e mal olmuştu; V3'ün constructor'ı bir `Config` girdisi daha
yazdığı için biraz üstünde beklenir, ama büyüklük sırası aynıdır.

**Toplam beklenen: ~4,01 XLM.**

**Bu, oturumda konulan 1,8 XLM üst sınırının üzerindedir.** Daha önce bu
belgede verilen "~0,5–1,5 XLM" tahmini yanlıştı; ölçüm onun yerini aldı.
Gönderim, sınırın yükseltilmesi açıkça onaylanmadan yapılmaz.

Bağlam, karar için: bu testnet XLM'idir, friendbot'tan bedava alınır ve parasal
karşılığı yoktur. İmzalayan hesapta 9 917 XLM var; 4 XLM bakiyenin %0,04'ü.
Yine de sınır sizin koyduğunuz sınırdır.

Kullanıcı tarafı işlemler (her biri ayrı imza, her biri öncesinde özet):

| İşlem | Ne yapar | Para hareketi |
| --- | --- | --- |
| `create_stop_order` | Emri kurar | Teminat cüzdandan vault'a |
| `trigger_stop` | Düşüşü kaydeder | **Yok** |
| `execute_stop` | Satışı dener | Kullanıcıya net, keeper'a ödül — ayrı iki transfer |
| `cancel_order` | Emri kapatır | Teminatın **tamamı** sahibine; ağ ücreti ayrıdır |

## 7. Alınan kararlar

| Karar | Değer |
| --- | --- |
| `max_amount_in` | `100000000` = 10.0000000 XLM (emir başına) |
| WASM | `--optimize=false`, zincirdeki hash `4ced7ccf…` |
| Test emirleri | A **ve** B, §5'teki sayılarla |
| Tetik | 0.1895 USDC/XLM |

### 7.1 Tetik marjı kaydı

Tetik seviyesi onaylandığında oracle 0.1898527 okuyordu; marj %0,19 idi.
Dokuz dakika sonra feed **0.1905785**'e çıktı ve aynı 0.1895 seviyesi
**%0,57 aşağıda** kaldı. Seviye hâlâ geçerli bir stop'tur (piyasanın altında),
ama gereken düşüş büyüdü.

Bu, seviyenin kötü seçildiği anlamına gelmez; fiyatın hareket ettiği anlamına
gelir. Emir oluşturulmadan hemen önce fiyat **tekrar okunacak** ve o anki marj
imza özetinde yazılacak. Seviye, siz aksini söylemedikçe 0.1895 kalır.

## 8. Deploy sonrası yapılacaklar

- `frontend/.env.local` ve Vercel'e `VITE_STOP_VAULT_CONTRACT_ID` (production'a
  **V3 testleri geçtikten sonra**).
- `keeper/.env` içine `STOP_VAULT_CONTRACT_ID`.
- `get_config` okunarak politikanın zincire yazıldığı gibi doğrulanması.
- Zincirdeki WASM hash'inin §2 ile karşılaştırılması.
