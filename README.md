# Maç Tahmin

API-Football verileriyle maç tahmini yapan, telefonda çalışan tek sayfalık web uygulaması.

- Model: lig sonuçlarından takım hücum/savunma gücü (zaman ağırlıklı), Poisson + Dixon-Coles skor dağılımı
- İsteğe bağlı: xG, korner/kart, sakat/cezalı, ilk 11, bahis oranları (değer karşılaştırması)
- API anahtarı sadece tarayıcıda (localStorage) saklanır, koda yazılmaz.

Sadece bilgilendirme amaçlıdır, bahis tavsiyesi değildir.
