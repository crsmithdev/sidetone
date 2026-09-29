package dev.crsmith.sidetone

import com.google.protobuf.ByteString
import io.livekit.android.room.RTCEngine
import io.livekit.android.test.MockE2ETest
import io.livekit.android.test.events.FlowCollector
import io.livekit.android.test.mock.MockDataChannel
import io.livekit.android.test.mock.TestData
import livekit.LivekitModels
import livekit.LivekitRtc
import livekit.org.webrtc.DataChannel
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.ByteBuffer

/**
 * The [Room] over a LiveKit room: what each event of the SDK becomes. The
 * room is LiveKit's own, connected to LiveKit's mock signal server under
 * Robolectric, so the events are the ones the SDK really emits.
 */
@RunWith(RobolectricTestRunner::class)
class LiveKitRoomTest : MockE2ETest() {
    private fun participant(identity: String, sid: String, state: LivekitModels.ParticipantInfo.State = LivekitModels.ParticipantInfo.State.ACTIVE) =
        TestData.REMOTE_PARTICIPANT.toBuilder().setIdentity(identity).setSid(sid).setState(state).clearTracks().build()

    private fun update(vararg participants: LivekitModels.ParticipantInfo) = LivekitRtc.SignalResponse.newBuilder()
        .setUpdate(LivekitRtc.ParticipantUpdate.newBuilder().addAllParticipants(participants.toList()))
        .build()

    private fun left(identity: String, sid: String) = update(participant(identity, sid, LivekitModels.ParticipantInfo.State.DISCONNECTED))

    /** What [LiveKitRoom] says while `act` runs against a connected room. */
    private suspend fun said(act: suspend () -> Unit): List<Room.Event> {
        connect()
        val collector = FlowCollector(LiveKitRoom(room).events, coroutineRule.scope)
        act()
        return collector.stopCollecting()
    }

    @Test
    fun aBridgeComingInIsSaidAndAPhoneIsNot() = runTest {
        val events = said {
            simulateMessageFromServer(update(participant("phone-1", "PA_phone")))
            simulateMessageFromServer(update(participant("bridge-1a2b", "PA_bridge")))
        }
        assertEquals(listOf(Room.Event.BridgeArrived), events)
    }

    @Test
    fun theLastBridgeLeavingIsSaidAsTheLast() = runTest {
        val events = said {
            simulateMessageFromServer(update(participant("bridge-old", "PA_old"), participant("bridge-new", "PA_new")))
            // 17.11.11 a restart: the old bridge leaves while the new one is in the room
            simulateMessageFromServer(left("bridge-old", "PA_old"))
            simulateMessageFromServer(left("bridge-new", "PA_new"))
        }
        assertEquals(
            listOf(Room.Event.BridgeArrived, Room.Event.BridgeArrived, Room.Event.BridgeLeft(last = false), Room.Event.BridgeLeft(last = true)),
            events,
        )
    }

    @Test
    fun aPhoneLeavingIsNotSaid() = runTest {
        val events = said {
            simulateMessageFromServer(update(participant("phone-1", "PA_phone")))
            simulateMessageFromServer(left("phone-1", "PA_phone"))
        }
        assertEquals(emptyList<Room.Event>(), events)
    }

    @Test
    fun theBridgeSpeakingIsSaidFromTheActiveSpeakers() = runTest {
        val speakers = { active: Boolean -> LivekitRtc.SignalResponse.newBuilder()
            .setSpeakersChanged(LivekitRtc.SpeakersChanged.newBuilder().addSpeakers(
                LivekitModels.SpeakerInfo.newBuilder().setSid("PA_bridge").setLevel(if (active) 0.8f else 0f).setActive(active),
            ))
            .build() }
        val events = said {
            simulateMessageFromServer(update(participant("bridge-1a2b", "PA_bridge")))
            simulateMessageFromServer(speakers(true))
            simulateMessageFromServer(speakers(false))
        }
        assertEquals(listOf(Room.Event.BridgeArrived, Room.Event.BridgeSpeaking(true), Room.Event.BridgeSpeaking(false)), events)
    }

    @Test
    fun onlyThePhonesOwnQualityIsSaid() = runTest {
        val quality = { sid: String -> LivekitRtc.SignalResponse.newBuilder()
            .setConnectionQuality(LivekitRtc.ConnectionQualityUpdate.newBuilder().addUpdates(
                LivekitRtc.ConnectionQualityInfo.newBuilder().setParticipantSid(sid).setQuality(LivekitModels.ConnectionQuality.POOR),
            ))
            .build() }
        val events = said {
            simulateMessageFromServer(update(participant("bridge-1a2b", "PA_bridge")))
            simulateMessageFromServer(quality("PA_bridge"))
            simulateMessageFromServer(quality(TestData.LOCAL_PARTICIPANT.sid))
        }
        assertEquals(listOf(Room.Event.BridgeArrived, Room.Event.Quality("poor")), events)
    }

    private fun leave(reason: LivekitModels.DisconnectReason, action: LivekitRtc.LeaveRequest.Action = LivekitRtc.LeaveRequest.Action.DISCONNECT) =
        TestData.LEAVE.toBuilder().setLeave(TestData.LEAVE.leave.toBuilder().setReason(reason).setAction(action)).build()

    @Test
    fun aRoomTheServerEndsIsSaidWithItsReason() = runTest {
        val events = said { simulateMessageFromServer(leave(LivekitModels.DisconnectReason.SERVER_SHUTDOWN)) }
        assertEquals(listOf(Room.Event.Ended("server shutdown")), events)
    }

    @Test
    fun aRoomThatEndsForNoReasonIsADroppedConnection() = runTest {
        val events = said { simulateMessageFromServer(leave(LivekitModels.DisconnectReason.UNKNOWN_REASON)) }
        assertEquals(listOf(Room.Event.Ended("the connection dropped")), events)
    }

    @Test
    fun aLinkThatDropsIsAReconnectThenADroppedConnection() = runTest {
        // the mock server takes no reconnect, so LiveKit tries until it gives up, as in a long tunnel
        val events = said {
            disconnectPeerConnection()
            coroutineRule.dispatcher.scheduler.advanceUntilIdle()
        }
        assertEquals(listOf(Room.Event.Reconnecting, Room.Event.Ended("the connection dropped")), events)
    }

    @Test
    fun whatTheBridgeSendsArrivesAsData() = runTest {
        val payload = """{"kind":"heard","text":"hello"}""".encodeToByteArray()
        val events = said {
            val channel = MockDataChannel(RTCEngine.RELIABLE_DATA_CHANNEL_LABEL)
            getSubscriberPeerConnection().observer!!.onDataChannel(channel)
            val packet = LivekitModels.DataPacket.newBuilder()
                .setUser(LivekitModels.UserPacket.newBuilder().setPayload(ByteString.copyFrom(payload)))
                .build()
            channel.simulateBufferReceived(DataChannel.Buffer(ByteBuffer.wrap(packet.toByteArray()), true))
        }
        assertEquals(1, events.size)
        assertArrayEquals(payload, (events.single() as Room.Event.Data).payload)
    }

    @Test
    fun whatThePhoneSendsGoesOutOnTheReliableChannel() = runTest {
        connect()
        val payload = """{"kind":"said","text":"hello"}""".encodeToByteArray()
        assertTrue(LiveKitRoom(room).send(payload).isSuccess)
        val channel = getPublisherPeerConnection().dataChannels.getValue(RTCEngine.RELIABLE_DATA_CHANNEL_LABEL) as MockDataChannel
        val sent = LivekitModels.DataPacket.parseFrom(channel.sentPayloads.single())
        assertArrayEquals(payload, sent.user.payload.toByteArray())
    }

    @Test
    fun theMicrophoneIsPublishedOnceAndUnpublishedWhenCut() = runTest {
        connect()
        val lk = LiveKitRoom(room)
        lk.openMic()
        lk.openMic()
        assertEquals(1, room.localParticipant.audioTrackPublications.size)
        lk.closeMic()
        assertEquals(0, room.localParticipant.audioTrackPublications.size)
    }
}
