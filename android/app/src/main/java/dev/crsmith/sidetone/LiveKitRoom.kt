package dev.crsmith.sidetone

import io.livekit.android.events.DisconnectReason
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.track.LocalAudioTrack
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/** The [Room] over a LiveKit room. It holds the microphone track the room published. */
class LiveKitRoom(private val room: io.livekit.android.room.Room) : Room {
    private var mic: LocalAudioTrack? = null

    override val events: Flow<Room.Event> = room.events.events.mapNotNull(::event)

    private fun event(event: RoomEvent): Room.Event? = when (event) {
        is RoomEvent.Reconnecting -> Room.Event.Reconnecting
        is RoomEvent.Reconnected -> Room.Event.Reconnected
        is RoomEvent.Disconnected -> Room.Event.Ended(event.error?.message ?: reasonWord(event.reason))
        // 17.11.11 a restart of the bridge leaves the phone's room up: only the bridge leaves it
        is RoomEvent.ParticipantConnected -> if (isBridge(event.participant.identity?.value)) Room.Event.BridgeArrived else null
        is RoomEvent.ParticipantDisconnected -> if (!isBridge(event.participant.identity?.value)) null else
            Room.Event.BridgeLeft(last = room.remoteParticipants.values.none { it != event.participant && isBridge(it.identity?.value) })
        // N.1.4 the phone reads its own uplink and tells the bridge
        is RoomEvent.ConnectionQualityChanged -> if (event.participant != room.localParticipant) null else Room.Event.Quality(event.quality.name.lowercase())
        // item 56 the phone reads what it received while the bridge speaks
        is RoomEvent.ActiveSpeakersChanged -> Room.Event.BridgeSpeaking(event.speakers.any { isBridge(it.identity?.value) })
        is RoomEvent.DataReceived -> Room.Event.Data(event.data)
        else -> null
    }

    override suspend fun send(payload: ByteArray): Result<Unit> = room.localParticipant.publishData(payload)

    override suspend fun received(): Received? = suspendCancellableCoroutine { done ->
        room.getSubscriberRTCStats { report ->
            done.resume(Received.of(report.statsMap.mapValues { (_, stat) -> Received.Stat(stat.type, stat.members) }))
        }
    }

    override suspend fun openMic() {
        if (mic != null) return
        val track = room.localParticipant.createAudioTrack()
        track.start()
        if (!room.localParticipant.publishAudioTrack(track)) {
            track.dispose()
            throw IllegalStateException("could not publish the microphone")
        }
        mic = track
    }

    override fun closeMic() {
        val track = mic ?: return
        mic = null
        room.localParticipant.unpublishTrack(track)
        track.dispose()
    }

    /** The room says why it ended as an enum, and the screen says it to Chris. */
    private fun reasonWord(reason: DisconnectReason): String = when (reason) {
        // what a link that dies in a tunnel gives back, with no message on it
        DisconnectReason.UNKNOWN_REASON -> "the connection dropped"
        else -> reason.name.lowercase().replace('_', ' ')
    }
}
