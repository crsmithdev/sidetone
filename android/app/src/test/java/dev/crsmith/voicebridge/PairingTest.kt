package dev.crsmith.voicebridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingTest {
    // the shape test/pairing.test.ts pins on the bridge side
    @Test
    fun readsTheLinkTheBridgePrints() {
        assertEquals(
            Link("https://lightbox2.tail15c879.ts.net:3100", "kelp-cedar-jetty"),
            parseLink("https://lightbox2.tail15c879.ts.net:3100/#pair=kelp-cedar-jetty"),
        )
        assertEquals(Link("http://10.0.2.2:3102", "onyx-tide-slate"), parseLink(" http://10.0.2.2:3102/#pair=onyx-tide-slate\n"))
    }

    @Test
    fun refusesAnythingElse() {
        assertNull(parseLink("https://lightbox2.tail15c879.ts.net:3100/"))
        assertNull(parseLink("https://example.com/#pair="))
        assertNull(parseLink("kelp-cedar-jetty"))
        assertNull(parseLink("ftp://host/#pair=kelp-cedar-jetty"))
    }

    @Test
    fun onlyARefusedTokenIsThrownAway() {
        assertTrue(refused("Expected HTTP 101 response but was '401 Unauthorized'"))
        assertTrue(refused("invalid token: token is expired"))
        // a token signed with a key the server no longer has
        assertTrue(refused("invalid API key"))
        assertFalse(refused("Unable to resolve host \"lightbox2.tail15c879.ts.net\""))
        assertFalse(refused("timeout"))
    }
}
