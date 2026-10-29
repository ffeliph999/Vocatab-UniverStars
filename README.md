# VocaTab — Otomi Kazuo & Otozora Rinly

Editor de canto que roda no navegador, com as vozes **Otomi Kazuo** e **Otozora Rinly**. É um fork do
[VocaTab](https://github.com/wavtechyukky/vocatab) (wavtechyukky, código MIT). Tudo roda no próprio navegador
(onnxruntime-web): nada é enviado a um servidor. Na primeira frase, o site baixa ~120 MB de modelos.

## O que muda em relação ao VocaTab original

- **Vozes:** só Kazuo e Rinly (`voicebanks/kazuo_rinly/`). São modelos ajustados a partir do LeapSinger v2
  (timbre) e do PrettyPitch (pitch e duração das consoantes). O voicebank original de 3 vozes não faz parte deste
  repositório.
- **Vocoder:** botão **NHVSing v3.2.1 / NSF-HiFiGAN** no painel "Singer & voice". O padrão é o NSF-HiFiGAN
  (pc-nsf-hifigan 2025.02), que reproduz as consoantes e respirações destas vozes com bem mais fidelidade. Com ele,
  dos ajustes de voz só Volume e Growl funcionam.
- **Smartphone:** o painel lateral vira uma gaveta (botão no canto superior esquerdo; toque fora para fechar), a
  barra de ferramentas quebra em linhas e os botões ficam maiores. No piano roll, dois dedos rolam a partitura e
  pinçar dá zoom; tocar duas vezes numa nota edita a letra.
- A voz do projeto de exemplo, que não existe aqui, é trocada pela primeira voz do voicebank.

## Publicar no GitHub Pages

1. Crie um repositório no GitHub e envie esta pasta inteira, com git ou com o
   [GitHub Desktop](https://desktop.github.com/). O envio pelo site do GitHub para em 25 MB por arquivo, e
   `acoustic.onnx` (52 MB) e o `vocoder.onnx` do NSF-HiFiGAN (54 MB) passam disso. Acima de 50 MB o GitHub só
   avisa; o limite é 100 MB. Não use Git LFS: o GitHub Pages não serve arquivos do LFS.
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
- **NHVSing v3.2.1** (`vocoders/nhvsing_v3_2_1/`): pesos do [NHVSing](https://github.com/wavtechyukky/NHVSing)
  (código MIT; os pesos são de uso não comercial), exportados para o formato do VocaTab a partir dos pesos publicados.
- **pc-nsf-hifigan 2025.02** (`vocoders/pc_nsf_hifigan_2025_02/`): OpenVPI,
  [DiffSinger Community Vocoder Project](https://openvpi.github.io/vocoders/), licença
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/); redistribuído sem modificações, com o aviso
  em `NOTICE.txt`. Outras versões e atualizações estão no site oficial.

A documentação original do VocaTab está em `README.vocatab.md` (japonês) e `README.vocatab.en.md` (inglês).
