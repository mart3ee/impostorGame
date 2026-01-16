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

function roomKey(code: string) {
  return `room:${code}`;
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 5; i++) {
    const index = Math.floor(Math.random() * alphabet.length);
    result += alphabet[index];
  }
  return result;
}

async function createUniqueRoomCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateRoomCode();
    const exists = await redis.exists(roomKey(code));
    if (!exists) {
      return code;
    }
  }
  throw new Response("Não foi possível gerar uma sala. Tente novamente.", {
    status: 500,
  });
}

function buildVotingView(room: Room, playerId: string): VotingView {
  const now = Date.now();
  const activePlayerIds = room.players
    .map((player) => player.id)
    .filter((id) => !room.eliminatedPlayerIds.includes(id));
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
  } else if (room.state === "reveal" && room.lastVotingResult) {
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

function toView(room: Room, playerId: string): RoomView {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    throw new Response("Jogador não faz parte desta sala.", { status: 403 });
  }

  const isImpostor = room.impostorIds.includes(playerId);
  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
  }));

  const view: RoomView = {
    code: room.code,
    state: room.state,
    settings: room.settings,
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

async function saveRoom(room: Room) {
  await redis.set(roomKey(room.code), JSON.stringify(room), {
    ex: ROOM_TTL_SECONDS,
  });
}

function parseJson(request: NextRequest) {
  return request.json().catch(() => null);
}

export async function POST(request: NextRequest) {
  const body = await parseJson(request);
  if (!body) {
    return new Response("JSON inválido.", { status: 400 });
  }

  const { playerId, playerName, playerAvatar } = body as {
    playerId?: string;
    playerName?: string;
    playerAvatar?: string;
  };

  if (!playerId || typeof playerId !== "string") {
    return new Response("Identificador do jogador é obrigatório.", {
      status: 400,
    });
  }

  const trimmedName = (playerName ?? "").trim();
  if (!trimmedName) {
    return new Response("Nome do jogador é obrigatório.", { status: 400 });
  }

  const avatar = (playerAvatar ?? "😀").trim() || "😀";

  const code = await createUniqueRoomCode();

  const room: Room = {
    code,
    hostId: playerId,
    players: [
      {
        id: playerId,
        name: trimmedName,
        avatar,
      },
    ],
    state: "lobby",
    settings: {
      numImpostors: 1,
      category: "Conhecimento Geral",
      maxVotings: 2,
      votingDurationSeconds: 60,
    },
    secretWord: null,
    impostorIds: [],
    eliminatedPlayerIds: [],
    votes: {},
    votingEndsAt: null,
    totalVotings: 2,
    remainingVotings: 2,
    winner: null,
  };

  try {
    await saveRoom(room);

    return Response.json({
      roomCode: room.code,
      view: toView(room, playerId),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message
        ? `Erro ao criar sala: ${error.message}`
        : "Erro ao criar sala.";
    return new Response(message, { status: 500 });
  }
}
