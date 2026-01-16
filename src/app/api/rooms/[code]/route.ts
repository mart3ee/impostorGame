import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";

type Player = {
  id: string;
  name: string;
  avatar: string;
};

type RoomState = "lobby" | "in_progress" | "voting" | "reveal";

type RoomSettings = {
  numImpostors: number;
  category: string;
  maxVotings: number;
  votingDurationSeconds: number;
};

type Room = {
  code: string;
  hostId: string;
  players: Player[];
  state: RoomState;
  settings: RoomSettings;
  secretWord: string | null;
  impostorIds: string[];
  eliminatedPlayerIds: string[];
  votes: {
    [playerId: string]: string | "skip";
  };
  votingEndsAt: number | null;
  totalVotings: number;
  remainingVotings: number;
  lastVotingResult?: {
    eliminatedPlayerId: string | null;
    eliminatedWasImpostor: boolean;
    isTie: boolean;
    votesPerPlayer: {
      [playerId: string]: number;
    };
    skipVotes: number;
  };
  winner: "crewmates" | "impostors" | null;
};

type RoomViewPlayer = {
  id: string;
  name: string;
  avatar: string;
};

type VotingResultEntry = {
  player: RoomViewPlayer;
  votes: number;
};

type VotingView = {
  state: "idle" | "in_progress" | "results";
  endsAt: number | null;
  totalVoters: number;
  votesSubmitted: number;
  hasVoted: boolean;
  canVote: boolean;
  remainingVotings: number;
  totalVotings: number;
  options?: RoomViewPlayer[];
  result?: {
    eliminatedPlayer: RoomViewPlayer | null;
    eliminatedWasImpostor: boolean;
    isTie: boolean;
    skipVotes: number;
    votes: VotingResultEntry[];
  };
  gameOver: boolean;
  winner: "crewmates" | "impostors" | null;
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
  voting?: VotingView;
};

const ROOM_TTL_SECONDS = 60 * 60 * 6;

type Action =
  | "join"
  | "start"
  | "reveal"
  | "nextRound"
  | "kick"
  | "leave"
  | "startVoting"
  | "vote";

function roomKey(code: string) {
  return `room:${code}`;
}

async function getRoomOrError(code: string) {
  const data = await redis.get<string>(roomKey(code));
  if (!data) {
    throw new Response("Sala não encontrada.", { status: 404 });
  }
  const room = JSON.parse(data) as Room;
  return normalizeRoom(room);
}

async function saveRoom(room: Room) {
  await redis.set(roomKey(room.code), JSON.stringify(room), {
    ex: ROOM_TTL_SECONDS,
  });
}

async function deleteRoom(code: string) {
  await redis.del(roomKey(code));
}

function normalizeRoom(room: Room): Room {
  if (!room.settings) {
    room.settings = {
      numImpostors: 1,
      category: "Conhecimento Geral",
      maxVotings: 2,
      votingDurationSeconds: 60,
    };
  } else {
    if (typeof room.settings.maxVotings !== "number") {
      room.settings.maxVotings = 2;
    }
    if (typeof room.settings.votingDurationSeconds !== "number") {
      room.settings.votingDurationSeconds = 60;
    }
  }

  if (!Array.isArray(room.eliminatedPlayerIds)) {
    room.eliminatedPlayerIds = [];
  }

  if (!room.votes || typeof room.votes !== "object") {
    room.votes = {};
  }

  if (typeof room.votingEndsAt !== "number") {
    room.votingEndsAt = null;
  }

  if (typeof room.totalVotings !== "number") {
    room.totalVotings = room.settings.maxVotings;
  }

  if (typeof room.remainingVotings !== "number") {
    room.remainingVotings = room.totalVotings;
  }

  if (room.winner !== "crewmates" && room.winner !== "impostors") {
    room.winner = null;
  }

  return room;
}

function getActivePlayerIds(room: Room) {
  return room.players
    .map((player) => player.id)
    .filter((id) => !room.eliminatedPlayerIds.includes(id));
}

function buildVotingView(room: Room, playerId: string): VotingView {
  const now = Date.now();
  const activePlayerIds = getActivePlayerIds(room);
  const totalVoters = activePlayerIds.length;
  const votesEntries = Object.entries(room.votes);
  const votesSubmitted = votesEntries.filter(([id]) =>
    activePlayerIds.includes(id),
  ).length;
  const isPlayerActive = activePlayerIds.includes(playerId);
  const hasVoted = Boolean(room.votes[playerId]);
  const canVote =
    room.state === "voting" &&
    isPlayerActive &&
    !hasVoted &&
    room.votingEndsAt != null &&
    room.votingEndsAt > now;

  let state: VotingView["state"] = "idle";
  if (room.state === "voting") {
    state = "in_progress";
  } else if (room.lastVotingResult) {
    state = "results";
  }

  let options: RoomViewPlayer[] | undefined;
  if (state === "in_progress") {
    options = room.players
      .filter(
        (player) =>
          !room.eliminatedPlayerIds.includes(player.id) &&
          player.id !== playerId,
      )
      .map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
      }));
  }

  const resultVotes: VotingResultEntry[] = [];
  let eliminatedPlayer: RoomViewPlayer | null = null;
  let eliminatedWasImpostor = false;
  let isTie = false;
  let skipVotes = 0;

  if (room.lastVotingResult) {
    const lastVotingResult = room.lastVotingResult;
    const { votesPerPlayer } = lastVotingResult;
    skipVotes = lastVotingResult.skipVotes;
    const entries = Object.entries(votesPerPlayer);
    for (const [targetId, count] of entries) {
      const player = room.players.find((p) => p.id === targetId);
      if (!player) {
        continue;
      }
      resultVotes.push({
        player: {
          id: player.id,
          name: player.name,
          avatar: player.avatar,
        },
        votes: count,
      });
    }

    if (lastVotingResult.eliminatedPlayerId) {
      const player = room.players.find((p) => p.id === lastVotingResult.eliminatedPlayerId);
      if (player) {
        eliminatedPlayer = {
          id: player.id,
          name: player.name,
          avatar: player.avatar,
        };
        eliminatedWasImpostor = room.impostorIds.includes(player.id);
      }
    }

    isTie = lastVotingResult.isTie;
  }

  const votingView: VotingView = {
    state,
    endsAt: room.state === "voting" ? room.votingEndsAt : null,
    totalVoters,
    votesSubmitted,
    hasVoted,
    canVote,
    remainingVotings: room.remainingVotings,
    totalVotings: room.totalVotings,
    options,
    gameOver: room.winner != null,
    winner: room.winner,
  };

  if (state === "results") {
    votingView.result = {
      eliminatedPlayer,
      eliminatedWasImpostor,
      isTie,
      skipVotes,
      votes: resultVotes.sort((a, b) => b.votes - a.votes),
    };
  }

  return votingView;
}

function finalizeVoting(room: Room) {
  const activePlayerIds = getActivePlayerIds(room);
  const votesPerPlayer: {
    [playerId: string]: number;
  } = {};
  let skipVotes = 0;

  for (const voterId of activePlayerIds) {
    const target = room.votes[voterId];
    if (!target || target === "skip") {
      skipVotes += 1;
      continue;
    }
    if (!votesPerPlayer[target]) {
      votesPerPlayer[target] = 0;
    }
    votesPerPlayer[target] += 1;
  }

  let eliminatedPlayerId: string | null = null;
  let isTie = false;

  const entries = Object.entries(votesPerPlayer);
  let maxVotes = 0;
  for (const [, count] of entries) {
    if (count > maxVotes) {
      maxVotes = count;
    }
  }

  if (maxVotes === 0 || entries.length === 0) {
    isTie = true;
  } else {
    const top = entries.filter(([, count]) => count === maxVotes);
    if (top.length > 1) {
      isTie = true;
    } else {
      eliminatedPlayerId = top[0][0];
    }
  }

  if (
    eliminatedPlayerId &&
    !room.eliminatedPlayerIds.includes(eliminatedPlayerId)
  ) {
    room.eliminatedPlayerIds.push(eliminatedPlayerId);
  }

  room.lastVotingResult = {
    eliminatedPlayerId,
    eliminatedWasImpostor:
      eliminatedPlayerId != null &&
      room.impostorIds.includes(eliminatedPlayerId),
    isTie,
    votesPerPlayer,
    skipVotes,
  };

  if (room.remainingVotings > 0) {
    room.remainingVotings -= 1;
  }

  const aliveImpostors = room.impostorIds.filter(
    (id) => !room.eliminatedPlayerIds.includes(id),
  );

  if (aliveImpostors.length === 0) {
    room.winner = "crewmates";
  } else if (room.remainingVotings <= 0) {
    room.winner = "impostors";
  }

  if (room.winner) {
    room.state = "reveal";
  } else {
    room.state = "in_progress";
  }
  room.votingEndsAt = null;
}

function finalizeVotingIfNeeded(room: Room): boolean {
  if (room.state !== "voting") {
    return false;
  }

  const now = Date.now();
  const activePlayerIds = getActivePlayerIds(room);
  const votesSubmitted = Object.keys(room.votes).filter((id) =>
    activePlayerIds.includes(id),
  ).length;
  const allVoted =
    activePlayerIds.length > 0 && votesSubmitted >= activePlayerIds.length;
  const expired =
    room.votingEndsAt != null && room.votingEndsAt <= now;

  if (!expired && !allVoted) {
    return false;
  }

  finalizeVoting(room);
  return true;
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

  view.voting = buildVotingView(room, playerId);

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
    const changed = finalizeVotingIfNeeded(room);
    if (changed) {
      await saveRoom(room);
    }
    const view = toView(room, playerId);
    return Response.json(view);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    const message =
      error instanceof Error && error.message
        ? `Erro ao buscar sala: ${error.message}`
        : "Erro ao buscar sala.";
    return new Response(message, { status: 500 });
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

  const {
    action,
    playerId,
    playerName,
    playerAvatar,
    numImpostors,
    targetPlayerId,
    maxVotings,
  } = body as {
    action?: Action;
    playerId?: string;
    playerName?: string;
    playerAvatar?: string;
    numImpostors?: number;
    targetPlayerId?: string;
    maxVotings?: number;
  };

  if (!playerId || typeof playerId !== "string") {
    return new Response("Identificador do jogador é obrigatório.", {
      status: 400,
    });
  }

  const code = params.code.toUpperCase();

  try {
    const room = await getRoomOrError(code);
    finalizeVotingIfNeeded(room);

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
      const maxVotingsRequested =
        typeof maxVotings === "number" ? maxVotings : room.settings.maxVotings;

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

      if (maxVotingsRequested < 1) {
        return new Response("Quantidade de votações deve ser pelo menos 1.", {
          status: 400,
        });
      }

      room.settings.numImpostors = impostorsRequested;
      room.settings.maxVotings = maxVotingsRequested;

      const word = pickRandomWord();
      const playerIds = room.players.map((p) => p.id);
      const impostorIds = pickRandomImpostors(playerIds, impostorsRequested);

      const totalVotings = maxVotingsRequested;

      room.secretWord = word;
      room.impostorIds = impostorIds;
      room.state = "in_progress";
      room.eliminatedPlayerIds = [];
      room.votes = {};
      room.votingEndsAt = null;
      room.totalVotings = totalVotings;
      room.remainingVotings = totalVotings;
      room.lastVotingResult = undefined;
      room.winner = null;

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "startVoting") {
      if (room.hostId !== playerId) {
        return new Response("Apenas o anfitrião pode iniciar a votação.", {
          status: 403,
        });
      }

      if (room.state !== "in_progress") {
        return new Response("A votação só pode começar durante a rodada.", {
          status: 400,
        });
      }

      if (room.winner) {
        return new Response("O jogo já foi encerrado.", { status: 400 });
      }

      if (room.remainingVotings <= 0) {
        return new Response("Não há mais votações disponíveis.", {
          status: 400,
        });
      }

      const activePlayerIds = getActivePlayerIds(room);
      if (activePlayerIds.length < 3) {
        return new Response(
          "São necessários pelo menos 3 jogadores ativos para votar.",
          { status: 400 },
        );
      }

      room.state = "voting";
      room.votes = {};
      room.lastVotingResult = undefined;

      const duration =
        typeof room.settings.votingDurationSeconds === "number" &&
        room.settings.votingDurationSeconds > 0
          ? room.settings.votingDurationSeconds
          : 60;

      room.votingEndsAt = Date.now() + duration * 1000;

      await saveRoom(room);
      const view = toView(room, playerId);
      return Response.json(view);
    }

    if (action === "vote") {
      if (room.state !== "voting") {
        return new Response("A votação não está ativa no momento.", {
          status: 400,
        });
      }

      if (room.winner) {
        return new Response("O jogo já foi encerrado.", { status: 400 });
      }

      const activePlayerIds = getActivePlayerIds(room);
      if (!activePlayerIds.includes(playerId)) {
        return new Response("Apenas jogadores ativos podem votar.", {
          status: 403,
        });
      }

      if (room.votes[playerId]) {
        return new Response("Você já votou nesta rodada.", { status: 400 });
      }

      const now = Date.now();
      if (room.votingEndsAt != null && now > room.votingEndsAt) {
        finalizeVoting(room);
        await saveRoom(room);
        const view = toView(room, playerId);
        return Response.json(view);
      }

      if (!targetPlayerId || typeof targetPlayerId !== "string") {
        return new Response("Voto inválido.", { status: 400 });
      }

      const voteValue = targetPlayerId === "skip" ? "skip" : targetPlayerId;

      if (voteValue !== "skip") {
        if (voteValue === playerId) {
          return new Response("Você não pode votar em si mesmo.", {
            status: 400,
          });
        }

        const targetIsActive = activePlayerIds.includes(voteValue);
        if (!targetIsActive) {
          return new Response(
            "Você só pode votar em jogadores ativos na sala.",
            { status: 400 },
          );
        }
      }

      room.votes[playerId] = voteValue;

      const changed = finalizeVotingIfNeeded(room);
      if (changed) {
        await saveRoom(room);
        const view = toView(room, playerId);
        return Response.json(view);
      }

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
      room.votingEndsAt = null;

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
       room.eliminatedPlayerIds = [];
       room.votes = {};
       room.votingEndsAt = null;
       room.lastVotingResult = undefined;
       room.winner = null;
       room.totalVotings = room.settings.maxVotings;
       room.remainingVotings = room.settings.maxVotings;

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
    const message =
      error instanceof Error && error.message
        ? `Erro ao processar ação na sala: ${error.message}`
        : "Erro ao processar ação na sala.";
    return new Response(message, { status: 500 });
  }
}
