import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";

type Player = {
  id: string;
  name: string;
  avatar: string;
};

type RoomState = "lobby" | "in_progress" | "reveal";

type RoomSettings = {
  numImpostors: number;
  category: string;
};

type Room = {
  code: string;
  hostId: string;
  players: Player[];
  state: RoomState;
  settings: RoomSettings;
  secretWord: string | null;
  impostorIds: string[];
};

type RoomViewPlayer = {
  id: string;
  name: string;
  avatar: string;
};

type RoomView = {
  code: string;
  state: RoomState;
  settings: RoomSettings;
  players: RoomViewPlayer[];
  you: {
    id: string;
    name: string;
    avatar: string;
    isImpostor: boolean;
    secretWord: string | null;
  };
  reveal?: {
    word: string;
    impostors: RoomViewPlayer[];
  };
};

const ROOM_TTL_SECONDS = 60 * 60 * 6;

type Action =
  | "join"
  | "start"
  | "reveal"
  | "nextRound"
  | "kick"
  | "leave";

function roomKey(code: string) {
  return `room:${code}`;
}

async function getRoomOrError(code: string) {
  const data = await redis.get<string>(roomKey(code));
  if (!data) {
    throw new Response("Sala não encontrada.", { status: 404 });
  }
  const room = JSON.parse(data) as Room;
  return room;
}

async function saveRoom(room: Room) {
  await redis.set(roomKey(room.code), JSON.stringify(room), {
    ex: ROOM_TTL_SECONDS,
  });
}

async function deleteRoom(code: string) {
  await redis.del(roomKey(code));
}

function toView(room: Room, playerId: string): RoomView {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    throw new Response("Jogador não faz parte desta sala.", { status: 403 });
  }

  const isImpostor = room.impostorIds.includes(playerId);
  const players: RoomViewPlayer[] = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
  }));

  const view: RoomView = {
    code: room.code,
    state: room.state as RoomState,
    settings: room.settings as RoomSettings,
    players,
    you: {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      isImpostor,
      secretWord: isImpostor ? null : room.secretWord,
    },
  };

  if (room.state === "reveal" && room.secretWord) {
    const impostors = room.players
      .filter((p) => room.impostorIds.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name, avatar: p.avatar }));

    view.reveal = {
      word: room.secretWord,
      impostors,
    };
  }

  return view;
}

function pickRandomWord() {
  const GENERAL_WORDS: string[] = [
    // Lugares
    "Praia",
    "Cinema",
    "Escola",
    "Hospital",
    "Parque",
    "Restaurante",
    "Supermercado",
    "Hotel",
    "Biblioteca",
    "Shopping",
    "Padaria",
    "Aeroporto",
    "Estádio",
    "Piscina",
    "Bar",
    "Cafeteria",
    "Clube",
    "Garagem",
    "Cozinha",
    "Quarto",

    // Transportes
    "Carro",
    "Ônibus",
    "Avião",
    "Navio",
    "Bicicleta",
    "Moto",
    "Trem",
    "Metrô",
    "Caminhão",

    // Animais 
    "Cachorro",
    "Gato",
    "Pássaro",
    "Peixe",
    "Cavalo",
    "Vaca",
    "Galinha",
    "Porco",
    "Coelho",
    "Leão",
    "Tigre",
    "Elefante",
    "Macaco",
    "Urso",
    "Raposa",
    "Lobo",
    "Girafa",
    "Zebra",
    "Cobra",
    "Tartaruga",

    // Alimentos 
    "Arroz",
    "Feijão",
    "Pão",
    "Queijo",
    "Leite",
    "Café",
    "Chá",
    "Bolo",
    "Pizza",
    "Macarrão",
    "Hambúrguer",
    "Batata",
    "Salada",
    "Frango",
    "Carne",
    "Ovo",
    "Sopa",
    "Sanduíche",
    "Maçã",
    "Banana",
    "Laranja",
    "Uva",
    "Melancia",
    "Sorvete",
    "Chocolate",

    // Objetos 
    "Relógio",
    "Celular",
    "Chave",
    "Carteira",
    "Óculos",
    "Mochila",
    "Caderno",
    "Caneta",
    "Lápis",
    "Computador",
    "Televisão",
    "Controle remoto",
    "Ventilador",
    "Geladeira",
    "Fogão",
    "Micro-ondas",
    "Liquidificador",
    "Cadeira",
    "Mesa",
    "Sofá",
    "Lâmpada",
    "Fone de ouvido",

    // Esportes / Atividades 
    "Futebol",
    "Basquete",
    "Vôlei",
    "Tênis",
    "Natação",
    "Corrida",
    "Ciclismo",
    "Skate",
    "Surfe",
    "Boxe",
    "Judô",
    "Musculação",
    "Yoga",
    "Dança",

    // Ações 
    "Comer",
    "Beber",
    "Dormir",
    "Correr",
    "Andar",
    "Estudar",
    "Trabalhar",
    "Viajar",
    "Cozinhar",
    "Dirigir",
    "Comprar",
    "Ler",
    "Escrever",
    "Falar",
    "Ouvir",
    "Assistir",
    "Brincar",
  ];

  const index = Math.floor(Math.random() * GENERAL_WORDS.length);
  return GENERAL_WORDS[index];
}

function pickRandomImpostors(playerIds: string[], numImpostors: number) {
  const indices = playerIds.map((_, index) => index);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = indices[i];
    indices[i] = indices[j];
    indices[j] = temp;
  }
  const selected = indices.slice(0, numImpostors);
  return selected.map((index) => playerIds[index]);
}

function parseJson(request: NextRequest) {
  return request.json().catch(() => null);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
) {
  const params = await context.params;
  const playerId = request.nextUrl.searchParams.get("playerId");
  if (!playerId) {
    return new Response("Identificador do jogador é obrigatório.", {
      status: 400,
    });
  }

  try {
    const room = await getRoomOrError(params.code.toUpperCase());
    const view = toView(room, playerId);
    return Response.json(view);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return new Response("Erro ao buscar sala.", { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ code: string }> },
) {
  const params = await context.params;
  const body = await parseJson(request);
  if (!body) {
    return new Response("JSON inválido.", { status: 400 });
  }

  const { action, playerId, playerName, playerAvatar, numImpostors, targetPlayerId } = body as {
    action?: Action;
    playerId?: string;
    playerName?: string;
    playerAvatar?: string;
    numImpostors?: number;
    targetPlayerId?: string;
  };

  if (!playerId || typeof playerId !== "string") {
    return new Response("Identificador do jogador é obrigatório.", {
      status: 400,
    });
  }

  const code = params.code.toUpperCase();

  try {
    const room = await getRoomOrError(code);

    if (!action || action === "join") {
      const trimmedName = (playerName ?? "").trim();
      if (!trimmedName) {
        return new Response("Nome do jogador é obrigatório.", { status: 400 });
      }

      const avatar = (playerAvatar ?? "😀").trim() || "😀";

      const existingIndex = room.players.findIndex((p) => p.id === playerId);
      if (existingIndex >= 0) {
        room.players[existingIndex].name = trimmedName;
        room.players[existingIndex].avatar = avatar;
      } else {
        room.players.push({ id: playerId, name: trimmedName, avatar });
      }

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "start") {
      if (room.hostId !== playerId) {
        return new Response("Apenas o anfitrião pode iniciar o jogo.", {
          status: 403,
        });
      }

      if (room.state !== "lobby") {
        return new Response("O jogo já foi iniciado.", { status: 400 });
      }

      const totalPlayers = room.players.length;
      const impostorsRequested =
        typeof numImpostors === "number" ? numImpostors : room.settings.numImpostors;

      if (totalPlayers < 3) {
        return new Response("São necessários pelo menos 3 jogadores.", {
          status: 400,
        });
      }

      if (impostorsRequested < 1 || impostorsRequested >= totalPlayers) {
        return new Response(
          "Quantidade de impostores deve ser entre 1 e total de jogadores - 1.",
          { status: 400 },
        );
      }

      room.settings.numImpostors = impostorsRequested;

      const word = pickRandomWord();
      const playerIds = room.players.map((p) => p.id);
      const impostorIds = pickRandomImpostors(playerIds, impostorsRequested);

      room.secretWord = word;
      room.impostorIds = impostorIds;
      room.state = "in_progress";

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "reveal") {
      if (room.hostId !== playerId) {
        return new Response("Apenas o anfitrião pode revelar o resultado.", {
          status: 403,
        });
      }

      if (room.state !== "in_progress") {
        return new Response("O jogo ainda não está em andamento.", {
          status: 400,
        });
      }

      room.state = "reveal";

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "nextRound") {
      if (room.hostId !== playerId) {
        return new Response("Apenas o anfitrião pode iniciar nova rodada.", {
          status: 403,
        });
      }

      if (room.state === "lobby") {
        return new Response("O jogo ainda não foi iniciado.", {
          status: 400,
        });
      }

      room.state = "lobby";
      room.secretWord = null;
      room.impostorIds = [];

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "kick") {
      if (room.hostId !== playerId) {
        return new Response("Apenas o anfitrião pode remover jogadores.", {
          status: 403,
        });
      }

      if (room.state !== "lobby") {
        return new Response(
          "Jogadores só podem ser removidos antes do início do jogo.",
          { status: 400 },
        );
      }

      if (!targetPlayerId || typeof targetPlayerId !== "string") {
        return new Response("Jogador alvo inválido.", { status: 400 });
      }

      if (targetPlayerId === room.hostId) {
        return new Response("O anfitrião não pode ser removido.", {
          status: 400,
        });
      }

      const existingIndex = room.players.findIndex(
        (player) => player.id === targetPlayerId,
      );

      if (existingIndex === -1) {
        return new Response("Jogador não encontrado na sala.", {
          status: 404,
        });
      }

      room.players.splice(existingIndex, 1);

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "leave") {
      if (room.hostId === playerId) {
        await deleteRoom(code);
        return new Response(null, { status: 204 });
      }

      const existingIndex = room.players.findIndex(
        (player) => player.id === playerId,
      );

      if (existingIndex >= 0) {
        room.players.splice(existingIndex, 1);
        await saveRoom(room);
      }

      return new Response(null, { status: 204 });
    }

    return new Response("Ação inválida.", { status: 400 });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    return new Response("Erro ao processar ação na sala.", { status: 500 });
  }
}
