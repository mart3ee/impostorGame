"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type RoomState = "lobby" | "in_progress" | "voting" | "reveal";

type RoomSettings = {
  numImpostors: number;
  category: string;
  maxVotings: number;
  votingDurationSeconds: number;
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

const PLAYER_ID_KEY = "impostor-player-id";
const PLAYER_NAME_KEY = "impostor-player-name";
const PLAYER_AVATAR_KEY = "impostor-player-avatar";
const ROOM_CODE_KEY = "impostor-room-code";
const IS_HOST_KEY = "impostor-is-host";

const AVATARS = ["😀", "😎", "🤠", "🥳", "🤖", "👻", "👽", "🐶", "🐱", "🐵", "🦊", "🐼"];

function createLocalPlayerId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(36).slice(2);
  const time = Date.now().toString(36);
  return `${time}-${random}`;
}

async function createRoom(playerId: string, playerName: string, playerAvatar: string) {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ playerId, playerName, playerAvatar }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Erro ao criar sala.");
  }

  return (await response.json()) as {
    roomCode: string;
    view: RoomView;
  };
}

async function joinRoom(
  code: string,
  playerId: string,
  playerName: string,
  playerAvatar: string,
): Promise<RoomView> {
  const response = await fetch(`/api/rooms/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: "join",
      playerId,
      playerName,
      playerAvatar,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Erro ao entrar na sala.");
  }

  return (await response.json()) as RoomView;
}

type RoomError = Error & {
  status?: number;
};

async function fetchRoom(code: string, playerId: string): Promise<RoomView> {
  const response = await fetch(
    `/api/rooms/${code}?playerId=${encodeURIComponent(playerId)}`,
  );

  if (!response.ok) {
    const text = await response.text();
    const error: RoomError = new Error(
      text || "Erro ao buscar sala.",
    ) as RoomError;
    error.status = response.status;
    throw error;
  }

  return (await response.json()) as RoomView;
}

async function sendRoomAction(
  code: string,
  action: "start" | "reveal" | "nextRound" | "kick" | "startVoting" | "vote",
  playerId: string,
  options?: {
    numImpostors?: number;
    targetPlayerId?: string;
    maxVotings?: number;
  },
): Promise<RoomView> {
  const response = await fetch(`/api/rooms/${code}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action,
      playerId,
      ...(options ?? {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Erro ao processar ação da sala.");
  }

  return (await response.json()) as RoomView;
}

function normalizeRoomCode(code: string) {
  return code.replace(/[^a-zA-Z0-9]/g, "").slice(0, 5).toUpperCase();
}

export default function Home() {
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [playerName, setPlayerName] = useState("");
  const [playerAvatar, setPlayerAvatar] = useState(AVATARS[0]);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [roomView, setRoomView] = useState<RoomView | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [numImpostors, setNumImpostors] = useState(1);
  const [maxVotings, setMaxVotings] = useState(2);
  const [votingSecondsLeft, setVotingSecondsLeft] = useState<number | null>(
    null,
  );
  const [showVotingResultDetails, setShowVotingResultDetails] = useState(false);
  const [hideVotingOverlay, setHideVotingOverlay] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasRoom = Boolean(roomCode && roomView);
  const voting = roomView?.voting;
  const votingState = voting?.state;
  const votingEndsAt = voting?.endsAt;
  const votingHasResult = Boolean(voting?.result);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let id = localStorage.getItem(PLAYER_ID_KEY);
    if (!id) {
      id = createLocalPlayerId();
      localStorage.setItem(PLAYER_ID_KEY, id);
    }
    setPlayerId(id);

    const storedName = localStorage.getItem(PLAYER_NAME_KEY);
    if (storedName) {
      setPlayerName(storedName);
    }

    const storedAvatar = localStorage.getItem(PLAYER_AVATAR_KEY);
    if (storedAvatar && AVATARS.includes(storedAvatar)) {
      setPlayerAvatar(storedAvatar);
    } else {
      const randomAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];
      setPlayerAvatar(randomAvatar);
    }

    const storedRoom = localStorage.getItem(ROOM_CODE_KEY);
    const storedIsHost = localStorage.getItem(IS_HOST_KEY);

    if (storedRoom) {
      setRoomCode(storedRoom);
      setIsHost(storedIsHost === "true");
    }

    const searchParams = new URLSearchParams(window.location.search);
    const linkCode = searchParams.get("room");
    if (linkCode && !storedRoom) {
      setRoomCodeInput(normalizeRoomCode(linkCode));
    }
  }, []);

  useEffect(() => {
    if (!playerName || typeof window === "undefined") {
      return;
    }
    localStorage.setItem(PLAYER_NAME_KEY, playerName);
  }, [playerName]);

  useEffect(() => {
    if (!playerAvatar || typeof window === "undefined") {
      return;
    }
    localStorage.setItem(PLAYER_AVATAR_KEY, playerAvatar);
  }, [playerAvatar]);

  useEffect(() => {
    if (!roomCode || !playerId) {
      return;
    }

    const currentRoomCode = roomCode;
    const currentPlayerId = playerId;

    async function loadRoom() {
      try {
        const view = await fetchRoom(currentRoomCode, currentPlayerId);
        setRoomView(view);
        if (!isHost || view.state !== "lobby") {
          setNumImpostors(view.settings.numImpostors);
          setMaxVotings(view.settings.maxVotings);
        }
      } catch (error) {
        const roomError = error as RoomError;
        if (roomError.status === 403) {
          if (typeof window !== "undefined") {
            localStorage.removeItem(ROOM_CODE_KEY);
            localStorage.removeItem(IS_HOST_KEY);
          }
          setRoomCode(null);
          setRoomView(null);
          setIsHost(false);
          setError("Você foi removido da sala.");
          return;
        }
        if (roomError.status === 404) {
          if (typeof window !== "undefined") {
            localStorage.removeItem(ROOM_CODE_KEY);
            localStorage.removeItem(IS_HOST_KEY);
          }
          setRoomCode(null);
          setRoomView(null);
          setIsHost(false);
          setError("A sala não está mais disponível.");
          return;
        }
        setError(
          roomError instanceof Error
            ? roomError.message
            : "Não foi possível carregar a sala.",
        );
      }
    }

    loadRoom();
  }, [roomCode, playerId, isHost]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (votingState !== "in_progress" || !votingEndsAt) {
      setVotingSecondsLeft(null);
      return;
    }

    function updateCountdown() {
      const now = Date.now();
      const endsAt = votingEndsAt;
      if (!endsAt) {
        setVotingSecondsLeft(null);
        return;
      }
      const msLeft = endsAt - now;
      const seconds = Math.max(0, Math.ceil(msLeft / 1000));
      setVotingSecondsLeft(seconds);
    }

    updateCountdown();

    const intervalId = window.setInterval(updateCountdown, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [votingState, votingEndsAt]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (votingState !== "results" || !votingHasResult) {
      setShowVotingResultDetails(false);
      return;
    }

    setShowVotingResultDetails(false);

    const timeoutId = window.setTimeout(() => {
      setShowVotingResultDetails(true);
    }, 2000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [votingState, votingHasResult]);

  useEffect(() => {
    if (!roomCode || !playerId) {
      return;
    }

    const currentRoomCode = roomCode;
    const currentPlayerId = playerId;

    let cancelled = false;
    let timeoutId: number | null = null;

    async function poll() {
      try {
        const view = await fetchRoom(currentRoomCode, currentPlayerId);
        if (!cancelled) {
          setRoomView(view);
          if (!isHost || view.state !== "lobby") {
            setNumImpostors(view.settings.numImpostors);
            setMaxVotings(view.settings.maxVotings);
          }
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const roomError = error as RoomError;
        if (roomError.status === 403) {
          if (typeof window !== "undefined") {
            localStorage.removeItem(ROOM_CODE_KEY);
            localStorage.removeItem(IS_HOST_KEY);
          }
          setRoomCode(null);
          setRoomView(null);
          setIsHost(false);
          setError("Você foi removido da sala.");
          cancelled = true;
          return;
        }
        if (roomError.status === 404) {
          if (typeof window !== "undefined") {
            localStorage.removeItem(ROOM_CODE_KEY);
            localStorage.removeItem(IS_HOST_KEY);
          }
          setRoomCode(null);
          setRoomView(null);
          setIsHost(false);
          setError("A sala não está mais disponível.");
          cancelled = true;
          return;
        }
        setError(
          roomError instanceof Error
            ? roomError.message
            : "Não foi possível atualizar a sala.",
        );
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(poll, 2000);
        }
      }
    }

    timeoutId = window.setTimeout(poll, 2000);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [roomCode, playerId, isHost]);

  const shareLink = useMemo(() => {
    if (!roomCode || typeof window === "undefined") {
      return "";
    }
    const url = new URL(window.location.href);
    url.searchParams.set("room", roomCode);
    return url.toString();
  }, [roomCode]);

  async function handleCreateRoom() {
    if (!playerId) {
      return;
    }

    const trimmedName = playerName.trim();
    if (!trimmedName) {
      setError("Informe um nome para jogar.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await createRoom(playerId, trimmedName, playerAvatar);
      setRoomCode(result.roomCode);
      setRoomView(result.view);
      setIsHost(true);
      setNumImpostors(result.view.settings.numImpostors);
      setMaxVotings(result.view.settings.maxVotings);

      if (typeof window !== "undefined") {
        localStorage.setItem(ROOM_CODE_KEY, result.roomCode);
        localStorage.setItem(IS_HOST_KEY, "true");
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível criar a sala.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleJoinRoom() {
    if (!playerId) {
      return;
    }

    const trimmedName = playerName.trim();
    if (!trimmedName) {
      setError("Informe um nome para jogar.");
      return;
    }

    const code = normalizeRoomCode(roomCodeInput);
    if (code.length !== 5) {
      setError("Código da sala inválido.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const view = await joinRoom(code, playerId, trimmedName, playerAvatar);
      setRoomCode(code);
      setRoomView(view);
      setIsHost(false);
      setNumImpostors(view.settings.numImpostors);
      setMaxVotings(view.settings.maxVotings);

      if (typeof window !== "undefined") {
        localStorage.setItem(ROOM_CODE_KEY, code);
        localStorage.setItem(IS_HOST_KEY, "false");
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível entrar na sala.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleStartGame() {
    if (!playerId || !roomCode) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const view = await sendRoomAction(
        roomCode,
        "start",
        playerId,
        {
          numImpostors,
          maxVotings,
        },
      );
      setRoomView(view);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível iniciar o jogo.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleStartVoting() {
    if (!playerId || !roomCode) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const view = await sendRoomAction(roomCode, "startVoting", playerId);
      setRoomView(view);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível iniciar a votação.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleVote(targetPlayerId: string | "skip") {
    if (!playerId || !roomCode) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const view = await sendRoomAction(roomCode, "vote", playerId, {
        targetPlayerId,
      });
      setRoomView(view);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível registrar o seu voto.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleReveal() {
    if (!playerId || !roomCode) {
      return;
    }

    if (typeof window !== "undefined") {
      const shouldFinish = window.confirm(
        "Tem certeza que deseja finalizar a rodada e revelar o resultado?",
      );
      if (!shouldFinish) {
        return;
      }
    }

    setLoading(true);
    setError(null);

    try {
      const view = await sendRoomAction(roomCode, "reveal", playerId);
      setRoomView(view);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível revelar o jogo.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleNextRound() {
    if (!playerId || !roomCode) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const view = await sendRoomAction(roomCode, "nextRound", playerId);
      setRoomView(view);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Não foi possível iniciar nova rodada.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleKickPlayer(targetPlayerId: string) {
    if (!playerId || !roomCode) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const view = await sendRoomAction(roomCode, "kick", playerId, {
        targetPlayerId,
      });
      setRoomView(view);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível remover o jogador.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCopyLink() {
    if (!shareLink) {
      return;
    }

    try {
      if (
        typeof navigator !== "undefined" &&
        "clipboard" in navigator &&
        typeof window !== "undefined" &&
        window.isSecureContext
      ) {
        await navigator.clipboard.writeText(shareLink);
      } else if (typeof document !== "undefined") {
        const textarea = document.createElement("textarea");
        textarea.value = shareLink;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "-9999px";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setError("Link da sala copiado.");
    } catch {
      setError(`Não foi possível copiar o link automaticamente. Link: ${shareLink}`);
    }
  }

  function handleLeaveRoom() {
    if (!playerId || !roomCode) {
      setRoomCode(null);
      setRoomView(null);
      setIsHost(false);
      setRoomCodeInput("");
      if (typeof window !== "undefined") {
        localStorage.removeItem(ROOM_CODE_KEY);
        localStorage.removeItem(IS_HOST_KEY);
      }
      return;
    }

    const currentRoomCode = roomCode;
    const currentPlayerId = playerId;

    setLoading(true);
    setError(null);

    fetch(`/api/rooms/${currentRoomCode}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "leave",
        playerId: currentPlayerId,
      }),
    })
      .catch(() => {
      })
      .finally(() => {
        setLoading(false);
        setRoomCode(null);
        setRoomView(null);
        setIsHost(false);
        setRoomCodeInput("");
        if (typeof window !== "undefined") {
          localStorage.removeItem(ROOM_CODE_KEY);
          localStorage.removeItem(IS_HOST_KEY);
        }
      });
  }

  const gameOverWinner = voting?.winner ?? null;
  const isVotingInProgress = votingState === "in_progress";
  const isVotingResults = votingState === "results";
  const showVotingOverlay = Boolean(
    voting && (isVotingInProgress || isVotingResults) && !hideVotingOverlay,
  );
  const isInLobby = roomView?.state === "lobby";
  const isInVoting = roomView?.state === "voting";
  const isInGame = roomView?.state === "in_progress";
  const isInReveal = roomView?.state === "reveal";
  const isWinner =
    gameOverWinner != null && roomView
      ? gameOverWinner === "crewmates"
        ? !roomView.you.isImpostor
        : roomView.you.isImpostor
      : false;

  useEffect(() => {
    if (!voting || isVotingInProgress) {
      setHideVotingOverlay(false);
    }
  }, [voting, isVotingInProgress]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.header}>
          <h1 className={styles.title}>Impostor</h1>
          <p className={styles.subtitle}>Jogue com amigos no celular.</p>
        </header>

        <section className={styles.card}>
          {!hasRoom && (
            <>
              <div className={styles.field}>
                <label className={styles.label}>Seu nome</label>
                <input
                  className={styles.input}
                  value={playerName}
                  maxLength={20}
                  onChange={(event) => {
                    setPlayerName(event.target.value);
                  }}
                  placeholder="Como você quer aparecer na sala?"
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Avatar</label>
                <div className={styles.avatarGrid}>
                  {AVATARS.map((av) => (
                    <button
                      key={av}
                      type="button"
                      className={`${styles.avatarOption} ${playerAvatar === av ? styles.avatarSelected : ""}`}
                      onClick={() => setPlayerAvatar(av)}
                    >
                      {av}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.buttonsColumn}>
                <button
                  className={styles.primaryButton}
                  onClick={handleCreateRoom}
                  disabled={loading}
                >
                  Criar sala
                </button>

                <div className={styles.orDivider}>ou</div>

                <div className={styles.field}>
                  <label className={styles.label}>Entrar em sala</label>
                  <div className={styles.joinRow}>
                    <input
                      className={styles.input}
                      value={roomCodeInput}
                      onChange={(event) => {
                        const next = normalizeRoomCode(event.target.value);
                        setRoomCodeInput(next);
                      }}
                      placeholder="Código (ex: ABC12)"
                    />
                    <button
                      className={styles.secondaryButton}
                      onClick={handleJoinRoom}
                      disabled={loading}
                    >
                      Entrar
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}

          {hasRoom && roomView && (
            <>
              {showVotingOverlay && voting && (
                <div
                  className={styles.votingOverlay}
                  onClick={() => setHideVotingOverlay(true)}
                >
                  <div
                    className={styles.votingModal}
                    onClick={(event) => event.stopPropagation()}
                  >
                    {isVotingInProgress && (
                      <>
                        <div className={styles.votingModalHeader}>
                          <h2 className={styles.votingModalTitle}>Hora de votar</h2>
                          {typeof votingSecondsLeft === "number" && (
                            <span className={styles.votingTimer}>
                              {votingSecondsLeft}s
                            </span>
                          )}
                        </div>
                        <p className={styles.votingStatus}>
                          Escolha quem você acha que é o impostor.
                        </p>
                        <p className={styles.votingStatus}>
                          {voting.votesSubmitted} de {voting.totalVoters} jogadores já votaram
                        </p>
                        {voting.canVote ? (
                          <div className={styles.votingOptions}>
                            {voting.options?.map((player) => (
                              <button
                                key={player.id}
                                type="button"
                                className={styles.votingOptionButton}
                                disabled={loading}
                                onClick={() => handleVote(player.id)}
                              >
                                <div className={styles.playerInfo}>
                                  <span className={styles.playerAvatar}>
                                    {player.avatar || "😀"}
                                  </span>
                                  <span className={styles.votingOptionName}>
                                    {player.name}
                                  </span>
                                </div>
                              </button>
                            ))}
                            <button
                              type="button"
                              className={styles.votingOptionButton}
                              disabled={loading}
                              onClick={() => handleVote("skip")}
                            >
                              <span className={styles.votingOptionName}>
                                Pular voto
                              </span>
                              <span className={styles.votingSkipLabel}>
                                Não tenho certeza
                              </span>
                            </button>
                          </div>
                        ) : (
                          <p className={styles.votingStatus}>
                            {voting.hasVoted
                              ? "Seu voto foi registrado. Aguarde os outros jogadores."
                              : "Você não pode votar nesta rodada."}
                          </p>
                        )}
                      </>
                    )}

                    {isVotingResults && voting.result && (
                      <>
                        <div className={styles.votingModalHeader}>
                          <h2 className={styles.votingModalTitle}>Resultado da votação</h2>
                        </div>

                        {!showVotingResultDetails && (
                          <p className={styles.votingStatus}>
                            Revelando quem é o mais suspeito...
                          </p>
                        )}

                        {showVotingResultDetails && (
                          <>
                            <p className={styles.votingEliminated}>
                              {voting.result.isTie
                                ? "Empate. Ninguém foi eliminado."
                                : voting.result.eliminatedPlayer
                                  ? `${voting.result.eliminatedPlayer.name} foi eliminado${voting.result.eliminatedWasImpostor ? " e era o impostor." : "."}`
                                  : "Ninguém foi eliminado nesta rodada."}
                            </p>

                            <ul className={styles.votingResultsList}>
                              {voting.result.votes.map((entry) => (
                                <li
                                  key={entry.player.id}
                                  className={styles.votingResultItem}
                                >
                                  <div className={styles.playerInfo}>
                                    <span className={styles.playerAvatar}>
                                      {entry.player.avatar || "😀"}
                                    </span>
                                    <span className={styles.playerName}>
                                      {entry.player.name}
                                    </span>
                                  </div>
                                  <span className={styles.votingResultVotes}>
                                    {entry.votes}
                                  </span>
                                </li>
                              ))}
                              <li className={styles.votingResultItem}>
                                <span className={styles.playerName}>
                                  Pular voto
                                </span>
                                <span className={styles.votingResultVotes}>
                                  {voting.result.skipVotes}
                                </span>
                              </li>
                            </ul>

                            {voting.gameOver && voting.winner && (
                              <p className={styles.votingGameOver}>
                                {voting.winner === "crewmates"
                                  ? "Vitória dos tripulantes! Todos os impostores foram eliminados."
                                  : "Vitória dos impostores! Eles passaram despercebidos."}
                              </p>
                            )}
                            <button
                              type="button"
                              className={styles.secondaryButton}
                              onClick={() => setHideVotingOverlay(true)}
                            >
                              Fechar
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className={styles.roomHeader}>
                <div>
                  <span className={styles.roomLabel}>Sala</span>
                  <div className={styles.roomCode}>{roomView.code}</div>
                </div>
                <div className={styles.chip}>
                  {roomView.state === "lobby" && "Aguardando jogadores"}
                  {roomView.state === "in_progress" && "Rodada em andamento"}
                  {roomView.state === "voting" && "Votação em andamento"}
                  {roomView.state === "reveal" && "Fim da rodada"}
                </div>
              </div>

              <div className={styles.field}>
                <label className={styles.label}>Você</label>
                <div className={styles.youRow}>
                  <div className={styles.playerInfo}>
                    <span className={styles.playerAvatar}>
                      {roomView.you.avatar || "😀"}
                    </span>
                    <span className={styles.youName}>{roomView.you.name}</span>
                  </div>
                  {roomView.you.isImpostor && (
                    <span className={styles.youRole}>Impostor</span>
                  )}
                </div>
              </div>

              <div className={styles.secretCard}>
                {roomView.you.isImpostor && !isInReveal && (
                  <p className={styles.secretText}>Você é o impostor.</p>
                )}
                {!roomView.you.isImpostor && !isInReveal && (
                  <p className={styles.secretText}>
                    Palavra secreta:{" "}
                    <span className={styles.secretWord}>
                      {roomView.you.secretWord ?? "aguardando início"}
                    </span>
                  </p>
                )}
                {isInReveal && roomView.reveal && (
                  <div className={styles.revealBlock}>
                    <p className={styles.secretText}>
                      Palavra da rodada:{" "}
                      <span className={styles.secretWord}>
                        {roomView.reveal.word}
                      </span>
                    </p>
                    <p className={styles.secretText}>
                      Impostores:{" "}
                      <span className={styles.secretWord}>
                        {roomView.reveal.impostors
                          .map((player) => player.name)
                          .join(", ")}
                      </span>
                    </p>
                  </div>
                )}
              </div>

              {gameOverWinner && (
                <div
                  className={`${styles.gameOverBanner} ${
                    isWinner
                      ? styles.gameOverBannerWinner
                      : styles.gameOverBannerLoser
                  }`}
                >
                  {gameOverWinner === "crewmates"
                    ? "Os inocentes venceram! Todos os impostores foram eliminados."
                    : "Os impostores venceram! Eles enganaram a todos."}
                </div>
              )}

              <div className={styles.playersBlock}>
                <div className={styles.playersHeader}>
                  <span className={styles.label}>Jogadores na sala</span>
                  <span className={styles.playersCount}>
                    {roomView.players.length}
                  </span>
                </div>
                <ul className={styles.playersList}>
                  {roomView.players.map((player) => {
                    const canKick =
                      isHost &&
                      isInLobby &&
                      player.id !== roomView.you.id &&
                      !loading;

                    return (
                      <li key={player.id} className={styles.playerItem}>
                        <div className={styles.playerInfo}>
                          <span className={styles.playerAvatar}>
                            {player.avatar || "😀"}
                          </span>
                          <span className={styles.playerName}>
                            {player.name}
                          </span>
                        </div>
                        {canKick && (
                          <button
                            type="button"
                            className={styles.kickButton}
                            onClick={() => {
                              handleKickPlayer(player.id);
                            }}
                          >
                            remover
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>

              {isHost && (
                <div className={styles.hostBlock}>
                  <div className={styles.field}>
                    <label className={styles.label}>
                      Quantidade de impostores
                    </label>
                    <div className={styles.impostorSelector}>
                      <button
                        className={styles.smallButton}
                        disabled={numImpostors <= 1 || !isInLobby}
                        onClick={() => {
                          setNumImpostors((prev) =>
                            prev > 1 ? prev - 1 : prev,
                          );
                        }}
                      >
                        -
                      </button>
                      <span className={styles.impostorValue}>
                        {numImpostors}
                      </span>
                      <button
                        className={styles.smallButton}
                        disabled={
                          !isInLobby ||
                          numImpostors >= roomView.players.length - 1
                        }
                        onClick={() => {
                          setNumImpostors((prev) =>
                            prev < roomView.players.length - 1
                              ? prev + 1
                              : prev,
                          );
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className={styles.field}>
                    <label className={styles.label}>
                      Quantidade de votações
                    </label>
                    <div className={styles.impostorSelector}>
                      <button
                        className={styles.smallButton}
                        disabled={maxVotings <= 1 || !isInLobby}
                        onClick={() => {
                          setMaxVotings((prev) => (prev > 1 ? prev - 1 : prev));
                        }}
                      >
                        -
                      </button>
                      <span className={styles.impostorValue}>
                        {maxVotings}
                      </span>
                      <button
                        className={styles.smallButton}
                        disabled={!isInLobby}
                        onClick={() => {
                          setMaxVotings((prev) => prev + 1);
                        }}
                      >
                        +
                      </button>
                    </div>
                  </div>

                  <div className={styles.buttonsColumn}>
                    {isInLobby && (
                      <button
                        className={styles.primaryButton}
                        disabled={loading}
                        onClick={handleStartGame}
                      >
                        Iniciar jogo
                      </button>
                    )}

                    {isInGame && (
                      <>
                        <button
                          className={styles.primaryButton}
                          disabled={loading}
                          onClick={handleStartVoting}
                        >
                          Iniciar votação
                        </button>
                        <button
                          className={styles.primaryButton}
                          disabled={loading}
                          onClick={handleReveal}
                        >
                          Finalizar rodada
                        </button>
                      </>
                    )}

                    {isInVoting && (
                      <button
                        className={styles.primaryButton}
                        disabled
                      >
                        Votação em andamento
                      </button>
                    )}

                    {isInReveal && (
                      <button
                        className={styles.primaryButton}
                        disabled={loading}
                        onClick={handleNextRound}
                      >
                        Nova rodada
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className={styles.footerActions}>
                {roomCode && (
                  <button
                    className={styles.linkButton}
                    onClick={handleCopyLink}
                  >
                    Compartilhar link da sala
                  </button>
                )}
                <button className={styles.leaveButton} onClick={handleLeaveRoom}>
                  Sair da sala
                </button>
              </div>
            </>
          )}

          {error && (
            <div className={styles.errorBanner}>
              <span>{error}</span>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
