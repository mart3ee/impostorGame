import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";

type Player = {
  id: string;
  name: string;
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
};

type RoomView = {
  code: string;
  state: RoomState;
  settings: RoomSettings;
  players: RoomViewPlayer[];
  you: {
    id: string;
    name: string;
    isImpostor: boolean;
    secretWord: string | null;
  };
  reveal?: {
    word: string;
    impostors: RoomViewPlayer[];
  };
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

function toView(room: Room, playerId: string): RoomView {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) {
    throw new Response("Jogador não faz parte desta sala.", { status: 403 });
  }

  const isImpostor = room.impostorIds.includes(playerId);
  const players = room.players.map((p) => ({
    id: p.id,
    name: p.name,
  }));

  const view: RoomView = {
    code: room.code,
    state: room.state,
    settings: room.settings,
    players,
    you: {
      id: player.id,
      name: player.name,
      isImpostor,
      secretWord: isImpostor ? null : room.secretWord,
    },
  };

  if (room.state === "reveal" && room.secretWord) {
    const impostors = room.players
      .filter((p) => room.impostorIds.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name }));

    view.reveal = {
      word: room.secretWord,
      impostors,
    };
  }

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

  const { playerId, playerName } = body as {
    playerId?: string;
    playerName?: string;
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

  const code = await createUniqueRoomCode();

  const room: Room = {
    code,
    hostId: playerId,
    players: [
      {
        id: playerId,
        name: trimmedName,
      },
    ],
    state: "lobby",
    settings: {
      numImpostors: 1,
      category: "Conhecimento Geral",
    },
    secretWord: null,
    impostorIds: [],
  };

  await saveRoom(room);

  return Response.json({
    roomCode: room.code,
    view: toView(room, playerId),
  });
}
