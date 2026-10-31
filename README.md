# VocaTab — UniverStars

Editor de canto que roda no navegador, com as vozes **Otomi Kazuo** e **Otozora Rinly**. É um fork do
[VocaTab](https://github.com/wavtechyukky/vocatab) (wavtechyukky, código MIT). Tudo roda no próprio navegador
(onnxruntime-web): nada é enviado a um servidor. Na primeira frase, o site baixa ~66 MB de modelos.

## O que muda em relação ao VocaTab original

- **Vozes:** só Kazuo e Rinly (`voicebanks/kazuo_rinly/`). São modelos ajustados a partir do LeapSinger v2
  (timbre) e do PrettyPitch (pitch e duração das consoantes). O voicebank original de 3 vozes não faz parte deste
  repositório.
- **Vocoder:** NHVSing v3.3 (o VocaTab usa o v3.2.1). No painel **Voz**, a opção **Kazuo & Rinly (teste)** troca para um
  NHVSing ajustado a estas duas vozes, ainda em avaliação.
- **Smartphone:** o painel lateral vira uma gaveta (botão no canto superior esquerdo; toque fora para fechar), a
  barra de ferramentas quebra em linhas e os botões ficam maiores. Com o celular deitado, o cabeçalho fica numa
  linha (arraste para o lado para ver o resto) e a lista de faixas some para sobrar altura. No piano roll, a
  ferramenta **mão** (a primeira, já selecionada no celular) arrasta a partitura com um dedo; para mexer nas
  notas, escolha a ferramenta de seleção. Dois dedos também rolam a partitura, pinçar dá zoom, e tocar duas vezes
  numa nota edita a letra.
- **USTX do OpenUtau:** **File → Import score** também lê `.ustx` (notas, letras, tempo e faixas; `+` vira
  extensão, `br`/`br2` vira respiração, `か[k a]` usa só "か"). **File → Export USTX** grava as faixas de canto
  num `.ustx` (notas, letras, tempo e compasso; as curvas de pitch e expressões ficam por conta do OpenUtau).
- **Frases longas no celular:** o VocaTab só corta frases em pausas de 0,5 s ou mais, e um UST que só tem
  respirações curtas vira frases de 40 s a 2 min. O modelo e o vocoder usam ~8 MB de memória por segundo de frase,
  cada um, e o celular fecha a página. Aqui uma frase com mais de 16 s é dividida na pausa curta mais longa (ou,
  sem pausa, entre duas notas).
- **Letras do UTAU com cor de voz:** `み↓S`, `も↓S` etc. viram `み`, `も` (antes a análise parava com erro em `↓`).
- A voz do projeto de exemplo, que não existe aqui, é trocada pela primeira voz do voicebank.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub e envie esta pasta inteira, com git ou com o
   [GitHub Desktop](https://desktop.github.com/). O envio pelo site do GitHub para em 25 MB por arquivo, e o
   `acoustic.onnx` (52 MB) passa disso. Acima de 50 MB o GitHub só avisa; o limite é 100 MB. Não use Git LFS: o
   GitHub Pages não serve arquivos do LFS.
2. No repositório, abra **Settings → Pages → Source: GitHub Actions**.
3. A cada push na branch `main`, o workflow `.github/workflows/pages.yml` compila a interface (`ui/dist`) e
   publica o site em `https://<usuário>.github.io/<repositório>/`.

Se trocar ou acrescentar um voicebank ou vocoder, rode `python tools/export_web_assets.py` (precisa do
[PrettyPitch](https://github.com/wavtechyukky/PrettyPitch) ao lado desta pasta, ou de `PRETTYPITCH_ROOT`)
e envie o `web_index.json` e o `web.json` novos.

## Licenças e créditos

- **Código:** MIT (`LICENSE`), como o VocaTab; código de terceiros em `THIRD_PARTY_NOTICES.md`.
- **Vozes:** Otomi Kazuo (Felipe Souza) e Otozora Rinly (UniverStars), publicadas com a permissão dos dois.
- **Modelos das vozes** (`voicebanks/kazuo_rinly/`): ajustados a partir do
  [LeapSinger](https://github.com/wavtechyukky/LeapSinger) v2 e do [PrettyPitch](https://github.com/wavtechyukky/PrettyPitch),
  cujos modelos base foram treinados com os bancos de voz Oniku Kurumi, Natsume Yuuri e Namine Ritsu. **Uso pessoal
  e não comercial.** Os créditos dos bancos de voz estão em `CREDITS.txt`, e os termos da Natsume Yuuri, em
  `夏目悠李_利用規約.txt`. Ao publicar áudio feito aqui, credite a voz usada.
- **NHVSing v3.3** (`vocoders/nhvsing_v3_3/`): pesos do [NHVSing](https://github.com/wavtechyukky/NHVSing)
  (código MIT; os pesos são de uso não comercial), exportados para o formato do VocaTab a partir dos pesos publicados.
- **NHVSing Kazuo & Rinly** (`vocoders/nhvsing_vozes_v33/`): os mesmos pesos ajustados a estas duas vozes. **Uso pessoal e não comercial.**
- **js-yaml** (`ui/src/vendor/js-yaml.mjs`, para ler e gravar `.ustx`): [nodeca/js-yaml](https://github.com/nodeca/js-yaml), MIT.

A documentação original do VocaTab está em `README.vocatab.md` (japonês) e `README.vocatab.en.md` (inglês).
