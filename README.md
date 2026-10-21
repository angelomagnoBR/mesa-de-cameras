# Mesa de Câmeras

Módulo para Foundry VTT (v12 e v13) que coloca as câmeras dos jogadores **atrás das áreas transparentes** de uma arte PNG. A arte fica fixa na tela, como uma mesa de stream, e cada câmera aparece "dentro" da moldura desenhada.

## Instalação

No Foundry: **Add-on Modules → Install Module** e cole no campo *Manifest URL*:

```
https://raw.githubusercontent.com/angelomagnoBR/mesa-de-cameras/main/module.json
```

## Como usar

1. Crie a arte em PNG deixando **transparentes** os lugares onde as câmeras devem aparecer.
2. Coloque o PNG em alguma pasta do Foundry (ex.: `Data/mesas/`).
3. Como GM, abra o editor: **Configurações → Mesa de Câmeras → Abrir editor**, ou pelo botão na barra de controles de token.
4. Escolha a arte. O módulo detecta as áreas transparentes sozinho.
5. Em cada área, escolha qual usuário fica ali (pode ser o GM, ou deixar vazio).
   O módulo também detecta a **inclinação** de cada área. Para ajustar na mão, digite o ângulo ou arraste a bolinha amarela no topo da área.
6. Marque **Mesa ativa para todos** e salve.

Atalho do GM para ligar/desligar a mesa: **Shift + M**.

## Tokens, desenhos e textos

A mesa fica **atrás** do canvas do Foundry: tokens, desenhos, textos e réguas aparecem por cima dela normalmente. Com a mesa ativa, a cor e a imagem de fundo da cena ficam escondidas.

Dicas para a cena usada com a mesa:
- Desligue a **Visão de Token** da cena, senão a névoa pode escurecer a tela.
- Deixe a **Escuridão** em 0.
- Se a grade incomodar, use o tipo **Sem grade** ou deixe a opacidade dela em 0.

## Para os jogadores

- Na parte de baixo da **sua** foto ficam os botões de câmera e microfone (ficam bem clarinhos até você passar o mouse).
- Com a câmera desligada, aparece a imagem do seu personagem (ou o seu avatar, se não houver personagem vinculado).

## Configurações

| Configuração | O que faz |
|---|---|
| Mesa ativa | Liga a mesa para todos (GM) |
| Esconder o dock de câmeras padrão | Some com o dock normal enquanto a mesa está ativa; o áudio continua |
| Ocultar a mesa só para mim | Esconde a mesa só no seu computador |

No editor, o **Ajuste na tela** define como a arte se encaixa em janelas com proporção diferente: caber inteira (com bordas pretas), preencher (pode cortar as bordas) ou esticar.
