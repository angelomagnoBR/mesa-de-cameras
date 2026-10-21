# Mesa de Câmeras

Módulo para Foundry VTT (v12 e v13) que coloca as câmeras dos jogadores **atrás das áreas transparentes da imagem de fundo da cena**. Cada câmera aparece "dentro" da moldura desenhada na arte.

## Instalação

No Foundry: **Add-on Modules → Install Module** e cole no campo *Manifest URL*:

```
https://raw.githubusercontent.com/angelomagnoBR/mesa-de-cameras/main/module.json
```

## Como usar

1. Crie a arte em PNG deixando **transparentes** os lugares onde as câmeras devem aparecer.
2. Coloque essa arte como **imagem de fundo da cena** (Configurar Cena → Fundo).
3. Com a cena aberta, como GM, clique no botão **Mesa de Câmeras: configurar esta cena** (controles de token) ou vá em **Configurações → Mesa de Câmeras → Abrir editor**.
4. O módulo detecta as áreas transparentes do fundo sozinho, inclusive a inclinação de cada uma.
5. Em cada área, escolha qual usuário fica ali (pode ser o GM, ou deixar vazio). Para ajustar na mão: arraste para mover, quadrado amarelo para redimensionar, bolinha amarela no topo ou o campo de graus para girar.
6. Marque **Mesa ativa nesta cena** e salve.

Cada cena tem a sua própria mesa. Em cenas sem mesa, tudo fica normal.

Atalho do GM para ligar/desligar a mesa da cena atual: **Shift + M**.

## Como funciona

As câmeras são desenhadas **dentro** do canvas do Foundry, logo abaixo da imagem de fundo da cena. Os buracos transparentes deixam as câmeras aparecerem e tudo o que o Foundry desenha (tokens, desenhos, textos, réguas) continua por cima, normalmente. As câmeras acompanham a cena se você der zoom ou arrastar.

Dica: deixe a **Escuridão** da cena em 0 e a **Visão de Token** desligada, senão as câmeras também ficam escuras.

## Para os jogadores

- Passe o mouse sobre a **sua** foto para aparecerem os botões de câmera e microfone.
- Com a câmera desligada, aparece a imagem do seu personagem (ou o seu avatar, se não houver personagem vinculado).

## Configurações

| Configuração | O que faz |
|---|---|
| Esconder o dock de câmeras padrão | Some com o dock normal enquanto a mesa está ativa; o áudio continua |
| Ocultar a mesa só para mim | Esconde a mesa só no seu computador |
