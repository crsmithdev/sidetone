package dev.crsmith.sidetone

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PairingTest {
    /** The link the bridge prints, which `test/pairing.test.ts` checks against the bridge. */
    private val fixture = Json.parseToJsonElement(File("../../test/fixtures/pairing.json").readText()).jsonObject

    @Test
    fun readsTheLinkTheBridgePrints() {
        assertEquals(
            Link(fixture.getValue("origin").jsonPrimitive.content, fixture.getValue("code").jsonPrimitive.content),
            parseLink(fixture.getValue("link").jsonPrimitive.content),
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
