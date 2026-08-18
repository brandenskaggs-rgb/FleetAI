package com.fleetai.driver.obd

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** Evaluates profile formulas without executing arbitrary Kotlin or JavaScript. */
object ExtendedPidFormula {
    fun evaluate(expression: String, bytes: List<Int>): Double {
        require(bytes.all { it in 0..255 }) { "Formula input must contain unsigned bytes" }
        return Parser(expression, bytes).parse().also {
            require(it.isFinite()) { "Formula produced a non-finite value" }
        }
    }

    private class Parser(private val source: String, private val bytes: List<Int>) {
        private var index = 0

        fun parse(): Double {
            val result = parseComparison()
            skipSpace()
            require(index == source.length) { "Unexpected formula token at position $index" }
            return result
        }

        private fun parseComparison(): Double {
            var value = parseBitOr()
            while (true) {
                value = when {
                    consume("==") -> bool(value == parseBitOr())
                    consume("!=") -> bool(value != parseBitOr())
                    consume(">=") -> bool(value >= parseBitOr())
                    consume("<=") -> bool(value <= parseBitOr())
                    consume(">") -> bool(value > parseBitOr())
                    consume("<") -> bool(value < parseBitOr())
                    else -> return value
                }
            }
        }

        private fun parseBitOr(): Double {
            var value = parseBitXor()
            while (consume("|")) value = (value.toLong() or parseBitXor().toLong()).toDouble()
            return value
        }

        private fun parseBitXor(): Double {
            var value = parseBitAnd()
            while (consume("^")) value = (value.toLong() xor parseBitAnd().toLong()).toDouble()
            return value
        }

        private fun parseBitAnd(): Double {
            var value = parseShift()
            while (consume("&")) value = (value.toLong() and parseShift().toLong()).toDouble()
            return value
        }

        private fun parseShift(): Double {
            var value = parseAdditive()
            while (true) {
                value = when {
                    consume("<<") -> (value.toLong() shl parseAdditive().toInt()).toDouble()
                    consume(">>") -> (value.toLong() shr parseAdditive().toInt()).toDouble()
                    else -> return value
                }
            }
        }

        private fun parseAdditive(): Double {
            var value = parseMultiplicative()
            while (true) {
                value = when {
                    consume("+") -> value + parseMultiplicative()
                    consume("-") -> value - parseMultiplicative()
                    else -> return value
                }
            }
        }

        private fun parseMultiplicative(): Double {
            var value = parseUnary()
            while (true) {
                value = when {
                    consume("*") -> value * parseUnary()
                    consume("/") -> value / parseUnary()
                    consume("%") -> value % parseUnary()
                    else -> return value
                }
            }
        }

        private fun parseUnary(): Double = when {
            consume("+") -> parseUnary()
            consume("-") -> -parseUnary()
            consume("~") -> parseUnary().toLong().inv().toDouble()
            else -> parsePrimary()
        }

        private fun parsePrimary(): Double {
            skipSpace()
            if (consume("(")) {
                val value = parseComparison()
                require(consume(")")) { "Missing closing parenthesis" }
                return value
            }
            if (index < source.length && (source[index].isDigit() || source[index] == '.')) {
                return parseNumber()
            }
            val identifier = parseIdentifier()
            require(identifier.isNotBlank()) { "Expected number, byte, or function at position $index" }
            if (consume("(")) {
                val arguments = mutableListOf<Double>()
                if (!consume(")")) {
                    do arguments += parseComparison() while (consume(","))
                    require(consume(")")) { "Missing function closing parenthesis" }
                }
                return call(identifier, arguments)
            }
            val byteIndex = byteIndex(identifier)
            require(byteIndex in bytes.indices) { "Formula references unavailable byte $identifier" }
            return bytes[byteIndex].toDouble()
        }

        private fun parseNumber(): Double {
            skipSpace()
            val start = index
            while (index < source.length && (source[index].isDigit() || source[index] == '.')) index++
            return source.substring(start, index).toDouble()
        }

        private fun parseIdentifier(): String {
            skipSpace()
            val start = index
            while (index < source.length && source[index].isLetterOrDigit()) index++
            return source.substring(start, index)
        }

        private fun call(name: String, args: List<Double>): Double = when (name.lowercase()) {
            "abs" -> args.single().let(::abs)
            "min" -> requireArgs(name, args, 2).let { min(it[0], it[1]) }
            "max" -> requireArgs(name, args, 2).let { max(it[0], it[1]) }
            "signed8" -> args.single().toInt().and(0xff).let { if (it >= 0x80) it - 0x100 else it }.toDouble()
            "signed16" -> args.single().toInt().and(0xffff).let { if (it >= 0x8000) it - 0x10000 else it }.toDouble()
            "signed32" -> args.single().toLong().and(0xffff_ffffL).toInt().toDouble()
            "getbit" -> requireArgs(name, args, 2).let { ((it[0].toLong() shr it[1].toInt()) and 1L).toDouble() }
            "if" -> requireArgs(name, args, 3).let { if (it[0] != 0.0) it[1] else it[2] }
            "float32" -> requireArgs(name, args, 4).let { values ->
                var bits = 0
                values.forEach { bits = (bits shl 8) or it.toInt().and(0xff) }
                Float.fromBits(bits).toDouble()
            }
            "float64" -> requireArgs(name, args, 8).let { values ->
                var bits = 0L
                values.forEach { bits = (bits shl 8) or it.toLong().and(0xff) }
                Double.fromBits(bits)
            }
            else -> throw IllegalArgumentException("Unsupported formula function: $name")
        }

        private fun requireArgs(name: String, args: List<Double>, count: Int): List<Double> {
            require(args.size == count) { "$name expects $count arguments" }
            return args
        }

        private fun byteIndex(identifier: String): Int {
            require(identifier.matches(Regex("^[A-Z]{1,2}$"))) { "Unknown formula identifier: $identifier" }
            var value = 0
            identifier.forEach { value = value * 26 + (it - 'A' + 1) }
            return value - 1
        }

        private fun consume(token: String): Boolean {
            skipSpace()
            if (!source.startsWith(token, index)) return false
            index += token.length
            return true
        }

        private fun skipSpace() {
            while (index < source.length && source[index].isWhitespace()) index++
        }

        private fun bool(value: Boolean): Double = if (value) 1.0 else 0.0
    }
}
